// Live Karaoke Room — microphone + WebRTC voice mesh.
//
// Five people at most means a full mesh is the lightest option there is: every participant
// holds one RTCPeerConnection per other participant (≤ 4), sends one Opus stream on each and
// receives one from each. No media server, no mixing — the room server only relays the SDP
// and ICE messages (RoomClient.signal).
//
// Who calls whom: of any two participants, the one with the lexicographically smaller id
// makes the offer. Both sides learn about each other from the same roster, so exactly one
// offer is ever made per pair and the "glare" problem never arises.
//
// Self-healing: every pair carries an `epoch` chosen by its offerer. If a pair has not reached
// "connected" within PAIR_TIMEOUT_MS (a lost signal, a network change, ICE that failed for
// good), the offerer throws the connection away and starts over with a new epoch; the answerer
// sees the new epoch on the offer and rebuilds its side too. Messages of an old epoch are
// dropped, so a late candidate can never poison the new attempt.
//
// Playback: each remote stream runs through WebAudio (source → gain → analyser → output), so
// the per-person volume can go above 100% and every slot gets a live level meter. The stream
// is also attached to a muted <audio> element: Chromium (WebView2) delivers silence to a
// MediaStreamSource whose remote stream is not consumed by a media element.

const OPUS_BITRATE = 64_000;      // mono voice + singing: plenty, ~8 KB/s per direction per peer
const PAIR_TIMEOUT_MS = 10_000;

/** WebKitGTK builds without WebRTC (some Linux distros) have no RTCPeerConnection at all. */
export const webrtcSupported = () => typeof window !== "undefined" && typeof window.RTCPeerConnection === "function";
const WATCHDOG_MS = 3_000;

/** Prefer singing-friendly Opus parameters (mono, 64 kbps, in-band FEC, no DTX). */
function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  const want = { stereo: "0", "sprop-stereo": "0", maxaveragebitrate: String(OPUS_BITRATE), useinbandfec: "1", usedtx: "0", maxplaybackrate: "48000" };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const fm = sdp.match(re);
  if (fm) {
    const params = Object.fromEntries(fm[1].split(";").map((kv) => kv.trim().split("=")).filter((p) => p[0]));
    Object.assign(params, want);
    return sdp.replace(re, `a=fmtp:${pt} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(";")}`);
  }
  const line = `a=fmtp:${pt} ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(";")}`;
  return sdp.replace(m[0], `${m[0]}\r\n${line}`);
}

function rms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  // Map RMS to a 0..1 meter value with a gentle curve (speech peaks ~0.1–0.3 RMS).
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

export function micConstraints(singingMode, deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      // Echo cancellation stays on in both modes: the backing track coming out of speakers
      // would otherwise be sent back to everyone, late. Headphones remain the real fix.
      echoCancellation: true,
      // Noise suppression and AGC treat sustained notes as noise and pump the level —
      // great for talking, bad for singing.
      noiseSuppression: !singingMode,
      autoGainControl: !singingMode,
      latency: 0.01,
    },
    video: false,
  };
}

export class VoiceMesh {
  /**
   * @param {object} o
   * @param {string} o.selfId
   * @param {(to: string, data: object) => void} o.sendSignal
   * @param {RTCIceServer[]} o.iceServers
   * @param {(id: string, state: string) => void} [o.onPeerState]
   * @param {(levels: Record<string, number>) => void} [o.onLevels]
   */
  constructor({ selfId, sendSignal, iceServers, onPeerState, onLevels }) {
    this.selfId = selfId;
    this.sendSignal = sendSignal;
    this.iceServers = iceServers;
    this.onPeerState = onPeerState || (() => {});
    this.onLevels = onLevels || (() => {});
    this.peers = new Map();            // id → { pc, initiator, pendingIce, audioEl, source, gain, analyser, volume, muted }
    this.localStream = null;
    this.ctx = null;
    this.localAnalyser = null;
    this.micMuted = false;
    this._levelTimer = null;
    this._buf = new Float32Array(512);
    this._closed = false;
    this._watchdog = setInterval(() => this._checkPairs(), WATCHDOG_MS);
  }

  _checkPairs() {
    const now = Date.now();
    for (const peer of [...this.peers.values()]) {
      if (!peer.initiator || peer.pc.connectionState === "connected") continue;
      if (now - peer.since > PAIR_TIMEOUT_MS) this._resetPeer(peer.id, peer.epoch + 1);
    }
  }

  /** Throw a pair's connection away and start over (keeps the local volume / mute choice). */
  _resetPeer(id, epoch) {
    const old = this.peers.get(id);
    const pref = old ? { volume: old.volume, muted: old.muted } : {};
    this.removePeer(id);
    const peer = this._createPeer(id, pref, epoch);
    if (peer.initiator) this._makeOffer(peer);
    return peer;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Open the microphone. Throws the getUserMedia error (NotAllowedError, NotFoundError …). */
  async startMic({ singingMode = false, deviceId = "" } = {}) {
    this._ensureCtx();
    if (!navigator.mediaDevices?.getUserMedia || !webrtcSupported()) {
      const e = new Error("getUserMedia unavailable");
      e.name = "NotSupportedError";
      throw e;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(singingMode, deviceId));
    } catch (e) {
      // The chosen mic was unplugged or renamed: fall back to the Windows default.
      if (!deviceId || (e?.name !== "OverconstrainedError" && e?.name !== "NotFoundError")) throw e;
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(singingMode, ""));
    }
    if (this._closed) {
      stream.getTracks().forEach((t) => t.stop());
      throw Object.assign(new Error("closed"), { name: "AbortError" });
    }
    const track = stream.getAudioTracks()[0];
    track.enabled = !this.micMuted;
    this.localStream = stream;
    // Level meter for our own slot (not routed to the speakers — no self-monitoring echo).
    const src = this.ctx.createMediaStreamSource(stream);
    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 1024;
    src.connect(this.localAnalyser);
    // Peers that connected before the mic was ready get the track now.
    for (const peer of this.peers.values()) this._attachLocalTrack(peer);
    this._startMeters();
    return stream;
  }

  /** Switch to another microphone mid-room. Peers get the new track via replaceTrack. */
  async switchMic({ singingMode = false, deviceId = "" } = {}) {
    const old = this.localStream;
    await this.startMic({ singingMode, deviceId });
    if (old && old !== this.localStream) old.getTracks().forEach((t) => t.stop());
  }

  /** Re-apply constraints when switching talk ↔ singing mode, without renegotiating. */
  async setSingingMode(singingMode) {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints(micConstraints(singingMode).audio);
    } catch { /* some engines refuse live changes; the next mic start picks it up */ }
  }

  setMicMuted(muted) {
    this.micMuted = !!muted;
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = !this.micMuted; });
  }

  setPeerVolume(id, volume) {
    const p = this.peers.get(id);
    if (!p) return;
    p.volume = volume;
    this._applyGain(p);
  }

  setPeerMuted(id, muted) {
    const p = this.peers.get(id);
    if (!p) return;
    p.muted = !!muted;
    this._applyGain(p);
  }

  _applyGain(p) {
    if (!p.gain) return;
    const v = p.muted ? 0 : (p.volume ?? 1);
    p.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Bring the set of peer connections in line with the room roster. */
  syncPeers(participantIds, prefs = {}) {
    if (this._closed || !webrtcSupported()) return;   // still in the room, just without voice
    const want = new Set(participantIds.filter((id) => id !== this.selfId));
    for (const id of [...this.peers.keys()]) {
      if (!want.has(id)) this.removePeer(id);
    }
    for (const id of want) {
      if (!this.peers.has(id)) {
        const peer = this._createPeer(id, prefs[id]);
        if (peer.initiator) this._makeOffer(peer);
      }
    }
  }

  _createPeer(id, pref = {}, epoch = null) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: "max-bundle" });
    const initiator = this.selfId < id;
    const peer = {
      id, pc, initiator,
      // The offerer owns the epoch; the answerer learns it from the first offer.
      epoch: epoch ?? (initiator ? 1 : null),
      since: Date.now(),
      pendingIce: [],
      audioEl: null, source: null, gain: null, analyser: null,
      volume: pref.volume ?? 1, muted: !!pref.muted,
      sender: null, restarts: 0,
    };
    this.peers.set(id, peer);

    // The offerer creates the one sendrecv audio m-line up front, even before the mic is
    // ready, so adding the track later is a replaceTrack() — no renegotiation round trip.
    // The answerer must NOT add its own: a transceiver from addTransceiver() is never matched
    // to a remote m-line, so its track would go nowhere. It adopts the offer's instead.
    if (peer.initiator) {
      const tx = pc.addTransceiver("audio", { direction: "sendrecv" });
      peer.sender = tx.sender;
      this._attachLocalTrack(peer);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(id, { kind: "ice", epoch: peer.epoch, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => this._onRemoteTrack(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== peer) return;   // a replaced connection winding down
      const st = pc.connectionState;
      // `since` = when the pair last left "connected" (or was created); the watchdog rebuilds
      // pairs that stay unconnected for too long.
      if (st === "disconnected" || st === "failed") peer.since = Date.now();
      this.onPeerState(id, st);
      if (st === "failed" && peer.initiator && peer.restarts < 3) {
        peer.restarts += 1;
        this._makeOffer(peer, true);
      }
    };
    this.onPeerState(id, "new");
    return peer;
  }

  _attachLocalTrack(peer) {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track || !peer.sender) return;
    peer.sender.replaceTrack(track).catch(() => {});
    try {
      const params = peer.sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = OPUS_BITRATE;
      params.encodings[0].priority = "high";
      params.encodings[0].networkPriority = "high";
      peer.sender.setParameters(params).catch(() => {});
    } catch { /* older engines */ }
  }

  _onRemoteTrack(peer, stream) {
    const ctx = this._ensureCtx();
    if (peer.source) {
      try { peer.source.disconnect(); } catch { /* ignore */ }
    }
    if (!peer.audioEl) {
      peer.audioEl = new Audio();
      peer.audioEl.muted = true;        // sound goes through WebAudio; this only keeps it flowing
      peer.audioEl.autoplay = true;
    }
    peer.audioEl.srcObject = stream;
    peer.audioEl.play().catch(() => {});
    // Lowest-latency playout: singing together is all about the delay.
    for (const r of peer.pc.getReceivers()) {
      try { r.jitterBufferTarget = 0; } catch { /* unsupported */ }
      try { r.playoutDelayHint = 0; } catch { /* unsupported */ }
    }
    peer.source = ctx.createMediaStreamSource(stream);
    peer.gain = peer.gain || ctx.createGain();
    peer.analyser = peer.analyser || ctx.createAnalyser();
    peer.analyser.fftSize = 1024;
    peer.source.connect(peer.gain);
    peer.gain.connect(peer.analyser);
    peer.gain.connect(ctx.destination);
    this._applyGain(peer);
    // Level meters run for listen-only participants (no mic) too.
    this._startMeters();
  }

  async _makeOffer(peer, iceRestart = false) {
    try {
      const offer = await peer.pc.createOffer({ iceRestart });
      offer.sdp = tuneOpus(offer.sdp);
      await peer.pc.setLocalDescription(offer);
      this.sendSignal(peer.id, { kind: "offer", epoch: peer.epoch, sdp: peer.pc.localDescription.sdp });
    } catch (e) {
      console.warn("[karaoke] offer failed", e);
    }
  }

  async handleSignal(from, data) {
    if (this._closed || !data || !webrtcSupported()) return;
    let peer = this.peers.get(from);
    try {
      if (data.kind === "offer") {
        if (!peer) peer = this._createPeer(from, {}, data.epoch);
        else if (peer.epoch == null) peer.epoch = data.epoch;
        else if (peer.epoch !== data.epoch) peer = this._resetPeer(from, data.epoch);   // offerer started over
        await peer.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        if (!peer.sender) {
          const tx = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio");
          if (tx) {
            tx.direction = "sendrecv";
            peer.sender = tx.sender;
            this._attachLocalTrack(peer);
          }
        }
        await this._flushIce(peer);
        const answer = await peer.pc.createAnswer();
        answer.sdp = tuneOpus(answer.sdp);
        await peer.pc.setLocalDescription(answer);
        this.sendSignal(from, { kind: "answer", epoch: peer.epoch, sdp: peer.pc.localDescription.sdp });
      } else if (data.kind === "answer" && peer) {
        if (peer.epoch === data.epoch && peer.pc.signalingState === "have-local-offer") {
          await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
          await this._flushIce(peer);
        }
      } else if (data.kind === "ice" && peer) {
        if (peer.epoch != null && data.epoch !== peer.epoch) return;   // from an abandoned attempt
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
        else peer.pendingIce.push(data.candidate);
      }
    } catch (e) {
      console.warn("[karaoke] signal handling failed", data.kind, e);
    }
  }

  async _flushIce(peer) {
    const pending = peer.pendingIce.splice(0);
    for (const c of pending) {
      try { await peer.pc.addIceCandidate(c); } catch { /* stale candidate */ }
    }
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* ignore */ }
    try { p.source?.disconnect(); p.gain?.disconnect(); } catch { /* ignore */ }
    if (p.audioEl) { p.audioEl.srcObject = null; }
    this.onPeerState(id, "closed");
  }

  _startMeters() {
    if (this._levelTimer) return;
    this._levelTimer = setInterval(() => {
      const levels = {};
      if (this.localAnalyser) levels[this.selfId] = this.micMuted ? 0 : rms(this.localAnalyser, this._buf);
      for (const p of this.peers.values()) {
        if (p.analyser) levels[p.id] = rms(p.analyser, this._buf);
      }
      this.onLevels(levels);
    }, 100);
  }

  async stats() {
    const out = {};
    for (const p of this.peers.values()) {
      try {
        const report = await p.pc.getStats();
        report.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
            out[p.id] = { rttMs: Math.round((s.currentRoundTripTime || 0) * 1000) };
          }
        });
      } catch { /* closed */ }
    }
    return out;
  }

  close() {
    this._closed = true;
    clearInterval(this._levelTimer);
    clearInterval(this._watchdog);
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
