// Live Karaoke Room — the session controller and its React store.
//
// One session per window at most. It owns the RoomClient (transport), the VoiceMesh (mics),
// and either a HostPublisher or a GuestFollower (sync), and keeps a plain state object that the
// UI reads through useKaraoke(). It lives outside React so switching tabs, collapsing the
// overlay or re-mounting views never drops the room.

import { useSyncExternalStore } from "react";
import { getAudio, getNowPlaying } from "../now-playing.js";
import { RoomClient, RoomError } from "./room-client.js";
import { VoiceMesh } from "./voice-mesh.js";
import { HostPublisher, GuestFollower, PlayerClock } from "./sync.js";
import { DEFAULT_ICE_SERVERS, LOCAL_SERVER, MAX_PARTICIPANTS, normalizeServer, buildInvite } from "./protocol.js";

const LS = {
  name: "kodama-karaoke-name",
  server: "kodama-karaoke-last-server",
  relay: "kodama-karaoke-relay",
  turn: "kodama-karaoke-ice",
  singing: "kodama-karaoke-singing-mode",
  prefs: "kodama-karaoke-peer-prefs",      // by display name: { volume, muted }
  overlay: "kodama-karaoke-overlay",
  micDevice: "kodama-karaoke-mic-device",
};

const lsGet = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage full/blocked */ } };
const lsJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "") ?? d; } catch { return d; } };

const IDLE = {
  phase: "idle",              // idle | connecting | in-room
  error: null,                // last error code, for the modals / toast
  endReason: null,            // why the last room ended (closed, kicked, host_left …)
  roomId: null,
  server: null,
  invite: null,
  lanInvites: [],             // host only: CODE@ip for each LAN address
  isHost: false,
  selfId: null,
  participants: [],           // [{ id, name, slot, isHost, muted, connected }]
  maxParticipants: MAX_PARTICIPANTS,
  connection: "live",         // live | reconnecting
  peerStates: {},             // id → RTCPeerConnectionState
  peerPrefs: {},              // id → { volume, muted } (local only)
  micState: "off",            // off | starting | live | blocked | unsupported
  micMuted: false,
  singingMode: false,
  playback: null,             // latest host playback state
  lyrics: null,               // { videoId, status, source, lines }
  rttMs: null,
};

class KaraokeSession {
  constructor() {
    this.state = { ...IDLE, singingMode: lsGet(LS.singing) === "1" };
    this.levels = {};
    this._listeners = new Set();
    this._levelListeners = new Set();
    this.client = null;
    this.mesh = null;
    this.publisher = null;
    this.follower = null;
    this.clock = null;
    this._offs = [];
    window.addEventListener("pagehide", () => this.client?.leave());
  }

  // ── store plumbing ──────────────────────────────────────────────────────────
  subscribe = (fn) => { this._listeners.add(fn); return () => this._listeners.delete(fn); };
  getSnapshot = () => this.state;
  subscribeLevels = (fn) => { this._levelListeners.add(fn); return () => this._levelListeners.delete(fn); };
  getLevels = () => this.levels;

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this._listeners.forEach((l) => l());
  }

  // ── persisted preferences ───────────────────────────────────────────────────
  get savedName() { return lsGet(LS.name); }
  get lastServer() { return lsGet(LS.server); }
  get relayServer() { return lsGet(LS.relay); }
  get iceServers() {
    const extra = lsJson(LS.turn, null);
    return Array.isArray(extra) && extra.length ? [...DEFAULT_ICE_SERVERS, ...extra] : DEFAULT_ICE_SERVERS;
  }
  /** Optional TURN server, e.g. { urls: "turn:turn.example.com:3478", username, credential }. */
  setTurnServer(entry) {
    lsSet(LS.turn, JSON.stringify(entry?.urls ? [entry] : []));
  }
  /** Chosen microphone ("" = Windows default). Set from the Mic & sound check. */
  get micDeviceId() { return lsGet(LS.micDevice); }
  setMicDevice(id) {
    lsSet(LS.micDevice, id || "");
    // Already singing in a room: move the live mic over without leaving.
    if (this.mesh && this.state.micState === "live") {
      this.mesh.switchMic({ singingMode: this.state.singingMode, deviceId: id || "" }).catch(() => {});
    }
  }
  get overlayPrefs() { return lsJson(LS.overlay, { collapsed: false, x: null, y: null }); }
  saveOverlayPrefs(p) { lsSet(LS.overlay, JSON.stringify(p)); }

  // ── entering a room ─────────────────────────────────────────────────────────
  /**
   * Create a room. `relay` empty = host it on this computer (kodama-server on :9847, reachable
   * on the LAN); otherwise the URL of a stand-alone relay (karaoke_room.py --relay).
   */
  async createRoom({ name, relay = "" }) {
    if (this.state.phase !== "idle") await this.leave();
    const server = relay ? normalizeServer(relay) : LOCAL_SERVER;
    if (relay && !server) throw new RoomError("bad_server");
    lsSet(LS.name, name || "");
    lsSet(LS.relay, relay || "");
    this._set({ ...IDLE, singingMode: this.state.singingMode, phase: "connecting" });
    try {
      const client = await RoomClient.create(server, name);
      const invite = relay ? buildInvite(client.roomId, server) : client.roomId;
      const lanInvites = relay ? [] : (client.lan?.ips || []).map((ip) => buildInvite(client.roomId, normalizeServer(ip)));
      this._enter(client, { invite: lanInvites[0] || invite, lanInvites });
    } catch (e) {
      this._set({ phase: "idle", error: e.code || "error" });
      throw e;
    }
  }

  async joinRoom({ code, server, name }) {
    if (this.state.phase !== "idle") await this.leave();
    const base = normalizeServer(server);
    if (!base) throw new RoomError("bad_server");
    lsSet(LS.name, name || "");
    lsSet(LS.server, server || "");
    this._set({ ...IDLE, singingMode: this.state.singingMode, phase: "connecting" });
    try {
      const client = await RoomClient.join(base, code, name);
      this._enter(client, { invite: buildInvite(client.roomId, base), lanInvites: [] });
    } catch (e) {
      this._set({ phase: "idle", error: e.code || "error" });
      throw e;
    }
  }

  _enter(client, { invite, lanInvites }) {
    this.client = client;
    this.clock = new PlayerClock();
    this._set({
      phase: "in-room", error: null, endReason: null,
      roomId: client.roomId, server: client.server, invite, lanInvites,
      isHost: client.isHost, selfId: client.selfId, maxParticipants: client.maxParticipants || MAX_PARTICIPANTS,
    });

    this.mesh = new VoiceMesh({
      selfId: client.selfId,
      iceServers: this.iceServers,
      sendSignal: (to, data) => client.signal(to, data),
      onPeerState: (id, st) => this._set({ peerStates: { ...this.state.peerStates, [id]: st } }),
      onLevels: (lv) => { this.levels = lv; this._levelListeners.forEach((l) => l()); },
    });

    if (client.isHost) {
      this.publisher = new HostPublisher(client, {
        onPlayback: (s) => this._set({ playback: s }),
        onLyrics: (l) => this._set({ lyrics: l }),
      });
    } else {
      this.follower = new GuestFollower(client);
    }

    const on = (t, fn) => this._offs.push(client.on(t, fn));
    on("snapshot", (s) => {
      this._applyRoster(s.participants);
      if (!client.isHost) {
        this._set({ playback: s.playback, lyrics: s.lyrics });
        this.follower.apply(s.playback);
      } else {
        this.publisher.resend();
      }
    });
    on("participants", (d) => this._applyRoster(d.participants));
    on("playback", (s) => {
      if (client.isHost) return;
      this._set({ playback: s });
      this.follower.apply(s);
    });
    on("lyrics", (l) => { if (!client.isHost) this._set({ lyrics: l }); });
    on("signal", (d) => this.mesh?.handleSignal(d.from, d.data));
    on("mic", (d) => this._set({ participants: this.state.participants.map((p) => (p.id === d.id ? { ...p, muted: d.muted } : p)) }));
    on("peer-left", (d) => this.mesh?.removePeer(d.id));
    on("connection", (c) => this._set({ connection: c }));
    on("clock", (c) => this._set({ rttMs: Math.round(c.rtt) }));
    on("closed", (d) => this._teardown(d.reason || "closed"));
    on("kicked", () => this._teardown("kicked"));
    on("lost", (why) => this._teardown(why));

    client.connect();
    if (this.publisher) this.publisher.start();
    if (this.follower) this.follower.start();
    this.startMic();
  }

  _applyRoster(list) {
    const participants = Array.isArray(list) ? list : [];
    const saved = lsJson(LS.prefs, {});
    const peerPrefs = { ...this.state.peerPrefs };
    for (const p of participants) {
      if (!peerPrefs[p.id]) peerPrefs[p.id] = saved[p.name] || { volume: 1, muted: false };
    }
    this._set({ participants, peerPrefs });
    this.mesh?.syncPeers(participants.map((p) => p.id), peerPrefs);
  }

  // ── microphone ──────────────────────────────────────────────────────────────
  async startMic() {
    if (!this.mesh || this.state.micState === "starting" || this.state.micState === "live") return;
    // A retry after a refusal is the user asking to be heard: come back unmuted.
    const isRetry = this.state.micState !== "off";
    this._set({ micState: "starting" });
    try {
      await this.mesh.startMic({ singingMode: this.state.singingMode, deviceId: this.micDeviceId });
      if (!this.mesh) return;          // left the room while the permission prompt was up
      this.setMicMuted(isRetry ? false : this.state.micMuted);
      this._set({ micState: "live" });
      this._native("karaoke_voice_active", { active: true });
    } catch (e) {
      if (!this.mesh) return;
      this.micError = e?.name || "Error";
      const blocked = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      this._set({ micState: e?.name === "NotSupportedError" ? "unsupported" : (blocked ? "blocked" : "error") });
      // Still in the room: they can listen and follow the lyrics without a mic.
      this.setMicMuted(true);
    }
  }

  setMicMuted(muted) {
    this.mesh?.setMicMuted(muted);
    this._set({ micMuted: !!muted });
    this.client?.setMic(!!muted);
  }

  toggleMic() {
    if (this.state.micState !== "live") { this.startMic(); return; }
    this.setMicMuted(!this.state.micMuted);
  }

  setSingingMode(on) {
    lsSet(LS.singing, on ? "1" : "0");
    this._set({ singingMode: !!on });
    this.mesh?.setSingingMode(!!on);
  }

  // ── per-person controls (local only) ────────────────────────────────────────
  _savePref(id, pref) {
    const peerPrefs = { ...this.state.peerPrefs, [id]: pref };
    this._set({ peerPrefs });
    const name = this.state.participants.find((p) => p.id === id)?.name;
    if (name) {
      const saved = lsJson(LS.prefs, {});
      saved[name] = pref;
      lsSet(LS.prefs, JSON.stringify(saved));
    }
  }

  setPeerVolume(id, volume) {
    const pref = { ...(this.state.peerPrefs[id] || { muted: false }), volume };
    this.mesh?.setPeerVolume(id, volume);
    this._savePref(id, pref);
  }

  togglePeerMuted(id) {
    const cur = this.state.peerPrefs[id] || { volume: 1, muted: false };
    const pref = { ...cur, muted: !cur.muted };
    this.mesh?.setPeerMuted(id, pref.muted);
    this._savePref(id, pref);
  }

  async kick(id) {
    if (!this.state.isHost) return;
    try { await this.client?.kick(id); } catch { /* already gone */ }
  }

  // ── time for the lyrics view ────────────────────────────────────────────────
  /** Current song time in seconds for rendering lyrics on this machine. */
  songTime() {
    const st = this.state;
    const pb = st.playback;
    if (!pb?.track) return this.clock?.now() ?? 0;
    // Our player is on the room's song: its own clock is the smoothest source, and the
    // follower keeps it on the host's. Otherwise (still loading, unavailable here) fall back
    // to the host's extrapolated playhead so the lyrics keep going regardless.
    const localVid = getNowPlaying().track?.videoId;
    const a = getAudio();
    if (st.isHost || (localVid === pb.track.videoId && a && !a.isPreparing)) return this.clock.now();
    return this.follower?.expectedPosition() ?? this.clock?.now() ?? 0;
  }

  // ── leaving ─────────────────────────────────────────────────────────────────
  async leave() {
    this.client?.leave();
    this._teardown(null);
  }

  _teardown(reason) {
    this._offs.forEach((off) => off());
    this._offs = [];
    this.publisher?.stop();
    this.follower?.stop();
    this.mesh?.close();
    this.clock?.dispose();
    if (this.client && !this.client._closed) this.client._shutdown();
    if (this.state.micState === "live") this._native("karaoke_voice_active", { active: false });
    this.client = this.mesh = this.publisher = this.follower = this.clock = null;
    this.levels = {};
    this._set({ ...IDLE, singingMode: this.state.singingMode, endReason: reason });
  }

  clearEndReason() {
    if (this.state.endReason || this.state.error) this._set({ endReason: null, error: null });
  }

  _native(cmd, args) {
    import("@tauri-apps/api/core").then(({ invoke }) => invoke(cmd, args)).catch(() => {});
  }
}

export const karaoke = new KaraokeSession();

export function useKaraoke() {
  return useSyncExternalStore(karaoke.subscribe, karaoke.getSnapshot);
}

export function useKaraokeLevels() {
  return useSyncExternalStore(karaoke.subscribeLevels, karaoke.getLevels);
}

export { RoomError };
