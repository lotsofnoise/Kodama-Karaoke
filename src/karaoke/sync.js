// Live Karaoke Room — playback + lyrics synchronisation.
//
// Every participant plays the song on their OWN Kodama player (the audio engine is native, not
// in the webview, so it cannot be streamed over WebRTC — and streaming it would cost far more
// bandwidth than the voices). The host's player is the reference:
//
//   HostPublisher  reads the host's player, publishes {track, position, isPlaying, at} where
//                  `at` is the moment `position` was sampled, on the room server's clock; and
//                  publishes the current song's word-level lyrics once per track.
//   GuestFollower  loads the same track into the guest's player and keeps it within ~0.3 s of
//                  the host: expected = position + (serverNow - at). Corrections are seeks with
//                  a cooldown, and the seek lead adapts to how long this machine takes to seek.
//
// Both read the player through Kodama's in-process now-playing store (src/now-playing.js).

import { getAudio, getNowPlaying, sendPlay, sendPlayerCommand } from "../now-playing.js";

const sendSeek = (seconds) => sendPlayerCommand({ action: "seek", position: Math.max(0, seconds) });
import { readLyricsCache } from "../lyrics/cache.js";
import { fetchLyrics } from "../lyrics/fetch.js";
import { readOffsets } from "../lyrics/offset.js";
import { DEFAULT_LYRICS_PROVIDERS, mergeLyricsProviders } from "../lyrics/providers.js";
import { parseDurationToSeconds } from "../lyrics/parse.js";
import { slimTrack, slimLyricLines } from "./protocol.js";

const HOST_TICK_MS = 250;
const HOST_HEARTBEAT_MS = 1000;
const HOST_JUMP_S = 0.75;          // position off by more than this from the extrapolation = a seek

const GUEST_TICK_MS = 400;
const DRIFT_PLAYING_S = 0.25;      // tolerated offset while playing (below an eighth note at 120 BPM)
const DRIFT_PAUSED_S = 0.15;
const SEEK_COOLDOWN_MS = 1500;
const TRACK_RETRY_MS = 8000;

function lyricsProviders() {
  try {
    const saved = localStorage.getItem("kiyoshi-lyrics-providers");
    if (saved) return mergeLyricsProviders(JSON.parse(saved));
  } catch { /* fall back to defaults */ }
  return DEFAULT_LYRICS_PROVIDERS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Smooth clock over the player. The native engine reports currentTime in coarse steps, so —
 * exactly like the lyrics overlay — we snapshot (time, performance.now) on every player event
 * and extrapolate between them while playing.
 */
export class PlayerClock {
  constructor() {
    this.snap = { ct: 0, pt: performance.now(), playing: false };
    this._audio = null;
    this._onEvt = () => this._take();
    this._poll = setInterval(() => this._bind(), 1000);
    this._bind();
  }

  _bind() {
    const a = getAudio();
    if (a === this._audio) return;
    this._unbind();
    this._audio = a;
    if (!a) return;
    for (const ev of ["timeupdate", "play", "pause", "seeked"]) a.addEventListener(ev, this._onEvt);
    this._take();
  }

  _unbind() {
    const a = this._audio;
    if (!a) return;
    for (const ev of ["timeupdate", "play", "pause", "seeked"]) a.removeEventListener(ev, this._onEvt);
  }

  _take() {
    const a = this._audio;
    this.snap = { ct: a?.currentTime || 0, pt: performance.now(), playing: !!a && !a.paused };
  }

  now() {
    const { ct, pt, playing } = this.snap;
    return playing ? ct + (performance.now() - pt) / 1000 : ct;
  }

  dispose() {
    clearInterval(this._poll);
    this._unbind();
  }
}

export class HostPublisher {
  /**
   * @param {import("./room-client.js").RoomClient} client
   * @param {{ onPlayback?: (s: object) => void, onLyrics?: (l: object) => void }} hooks
   */
  constructor(client, hooks = {}) {
    this.client = client;
    this.hooks = hooks;
    this.seq = 0;
    this.last = { vid: null, playing: null, pos: 0, at: 0 };
    this.lastSentAt = 0;
    this.lyricsVid = null;
    this.lyrics = null;
    this._lyricsAbort = null;
    this._lyricsChain = Promise.resolve();
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => this.tick(false), HOST_TICK_MS);
    this.tick(true);
  }

  stop() {
    clearInterval(this._timer);
    this._lyricsAbort?.abort();
  }

  /** Re-send everything (used after our stream reconnects). */
  resend() {
    this.tick(true);
    if (this.lyrics) this._publishLyrics(this.lyrics);
  }

  tick(force) {
    const np = getNowPlaying();
    const a = getAudio();
    const track = slimTrack(np.track);
    const vid = track?.videoId || "";
    const pos = a?.currentTime || 0;
    const playing = !!a && !a.paused && !!track;
    const now = this.client.serverNow();

    let urgent = force;
    if (vid !== this.last.vid || playing !== this.last.playing) urgent = true;
    else if (this.last.at) {
      const expected = this.last.pos + (this.last.playing ? (now - this.last.at) / 1000 : 0);
      if (Math.abs(pos - expected) > HOST_JUMP_S) urgent = true;
    }
    if (!urgent && now - this.lastSentAt < HOST_HEARTBEAT_MS) return;

    const lyricsOffset = vid ? (readOffsets()[vid] || 0) : 0;
    const state = { track, position: pos, isPlaying: playing, at: now, lyricsOffset, seq: ++this.seq };
    this.last = { vid, playing, pos, at: now };
    this.lastSentAt = now;
    this.client.publishPlayback(state, urgent);
    this.hooks.onPlayback?.(state);

    if (vid !== this.lyricsVid) this._loadLyrics(np.track);
  }

  async _loadLyrics(rawTrack) {
    this._lyricsAbort?.abort();
    const vid = rawTrack?.videoId || "";
    this.lyricsVid = vid;
    if (!vid) {
      this._publishLyrics({ videoId: "", status: "none", source: "", lines: [] });
      return;
    }
    const ac = new AbortController();
    this._lyricsAbort = ac;
    this._publishLyrics({ videoId: vid, status: "loading", source: "", lines: [] });

    // The host's own lyrics view is usually fetching this song right now and will cache the
    // result; give it a moment instead of hitting every provider twice.
    let found = null;
    for (let i = 0; i < 8 && !found; i++) {
      found = this._fromCache(vid);
      if (!found) await sleep(500);
      if (ac.signal.aborted) return;
    }
    if (!found) {
      try {
        const t = slimTrack(rawTrack);
        const res = await fetchLyrics(t.title, t.artists, t.album, parseDurationToSeconds(rawTrack.duration),
          lyricsProviders(), vid, ac.signal);
        if (res?.lrc?.length) found = { lines: res.lrc, source: res.source || "" };
      } catch { /* aborted or every provider failed */ }
    }
    if (ac.signal.aborted) return;
    const lines = slimLyricLines(found?.lines);
    this._publishLyrics({ videoId: vid, status: lines.length ? "ok" : "none", source: found?.source || "", lines });
  }

  _fromCache(vid) {
    try {
      const raw = readLyricsCache(vid);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.lrc) && parsed.lrc.length ? { lines: parsed.lrc, source: parsed.source || "" } : null;
    } catch {
      return null;
    }
  }

  _publishLyrics(payload) {
    this.lyrics = payload;
    this.hooks.onLyrics?.(payload);
    // Strictly in order: "loading" and the lines are posted back to back, and two concurrent
    // requests may arrive the other way round — guests would then sit on "loading" forever.
    this._lyricsChain = this._lyricsChain.then(() => this.client.publishLyrics(payload));
  }
}

export class GuestFollower {
  /** @param {import("./room-client.js").RoomClient} client */
  constructor(client) {
    this.client = client;
    this.state = null;
    this.cooldownUntil = 0;
    this.requested = { vid: null, at: 0 };
    this.seekLead = 0.05;          // seconds; learned from how far behind a seek lands
    this.lastAction = null;
    this._timer = null;
    this.enabled = true;
  }

  start() {
    this._timer = setInterval(() => this.tick(), GUEST_TICK_MS);
  }

  stop() {
    clearInterval(this._timer);
  }

  apply(state) {
    if (!state) return;
    if (this.state && state.seq && this.state.seq && state.seq < this.state.seq && state.at < this.state.at) return; // stale
    const changedTrack = state.track?.videoId !== this.state?.track?.videoId;
    const changedPlay = state.isPlaying !== this.state?.isPlaying;
    this.state = state;
    if (changedTrack || changedPlay) {
      this.cooldownUntil = 0;
      this.lastAction = null;      // what happens next says nothing about our seek latency
    }
    this.tick();
  }

  /** Where the host's playhead is right now, extrapolated on the shared server clock. */
  expectedPosition() {
    const st = this.state;
    if (!st) return null;
    const elapsed = st.isPlaying ? Math.max(0, (this.client.serverNow() - st.at) / 1000) : 0;
    return st.position + elapsed;
  }

  tick() {
    const st = this.state;
    if (!this.enabled || !st?.track?.videoId) return;
    const now = Date.now();
    const np = getNowPlaying();
    const a = getAudio();

    if (np.track?.videoId !== st.track.videoId) {
      if (this.requested.vid !== st.track.videoId || now - this.requested.at > TRACK_RETRY_MS) {
        this.requested = { vid: st.track.videoId, at: now };
        sendPlay(st.track, [st.track]);
        this.cooldownUntil = now + 1200;
      }
      return;
    }
    if (!a || a.isPreparing || now < this.cooldownUntil) return;

    const expected = this.expectedPosition();
    if (st.isPlaying && a.paused) {
      sendSeek(expected + this.seekLead);
      sendPlayerCommand("playpause");
      this.cooldownUntil = now + 800;
      this.lastAction = null;
      return;
    }
    if (!st.isPlaying && !a.paused) {
      sendPlayerCommand("playpause");
      sendSeek(expected);
      this.cooldownUntil = now + 800;
      this.lastAction = null;
      return;
    }

    const drift = a.currentTime - expected;          // + ahead of host, − behind
    const limit = st.isPlaying ? DRIFT_PLAYING_S : DRIFT_PAUSED_S;
    if (st.isPlaying && this.lastAction === "seek" && Math.abs(drift) < 1) {
      // Where the previous correction actually landed: the residual is roughly how long a
      // seek takes on this machine. Fold it into the lead so the next one lands on the beat.
      this.seekLead = Math.max(0, Math.min(1.0, this.seekLead - drift * 0.6));
    }
    this.lastAction = null;
    if (Math.abs(drift) <= limit) return;
    const dur = a.duration || Infinity;
    const target = Math.min(dur - 0.25, expected + (st.isPlaying ? this.seekLead : 0));
    if (target > 0) sendSeek(target);
    this.lastAction = "seek";
    this.cooldownUntil = now + SEEK_COOLDOWN_MS;
  }
}
