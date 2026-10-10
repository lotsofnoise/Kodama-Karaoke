// Live Karaoke Room — transport to the room server (python-backend/karaoke_room.py).
//
// Downstream: one EventSource per participant. Upstream: small JSON POSTs. Both go straight to
// the room server — the local kodama-server when hosting, the host's (or a relay's) address
// when joining. EventSource reconnects by itself; the server answers every (re)connect with a
// full snapshot, so nothing needs replaying on our side.

import { LOCAL_SERVER } from "./protocol.js";

/**
 * Requests to a room on ANOTHER machine go through this machine's own kodama-server
 * (/karaoke/via). The app's pages live on a secure origin (tauri://localhost,
 * https://tauri.localhost) from which WebKit refuses plain http://<lan-ip> as mixed content;
 * localhost is exempt, and the app's CSP stays limited to localhost:9847.
 */
export function routed(server, url) {
  return server === LOCAL_SERVER ? url : `${LOCAL_SERVER}/karaoke/via?url=${encodeURIComponent(url)}`;
}

export class RoomError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;       // "room_full" | "room_not_found" | "unreachable" | "forbidden" | ...
    this.status = status;
  }
}

async function requestJson(url, { method = "GET", body, timeout = 6000, keepalive = false } = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
      keepalive,
    });
  } catch {
    throw new RoomError("unreachable");
  }
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON error page */ }
  if (!resp.ok || data?.ok === false) {
    throw new RoomError(data?.error || (resp.status === 404 ? "room_not_found" : "http_" + resp.status), resp.status);
  }
  return data || {};
}

const EVENT_TYPES = ["snapshot", "participants", "playback", "lyrics", "signal", "mic", "peer-left", "closed", "kicked", "bye"];

export class RoomClient {
  /** Create a room on `server` (hosting). Returns a connected-ready client. */
  static async create(server, name) {
    const d = await requestJson(routed(server, `${server}/karaoke/rooms`), { method: "POST", body: { name } });
    return new RoomClient(server, d);
  }

  /** Join room `code` on `server`. Throws RoomError("room_full") when 5/5 are inside. */
  static async join(server, code, name) {
    const d = await requestJson(routed(server, `${server}/karaoke/rooms/${encodeURIComponent(code)}/join`), { method: "POST", body: { name } });
    return new RoomClient(server, d);
  }

  /** Server capabilities (max participants, LAN addresses when asked locally). */
  static info(server) {
    return requestJson(routed(server, `${server}/karaoke/info`), { timeout: 3000 });
  }

  constructor(server, joinResponse) {
    this.server = server;
    this.roomId = joinResponse.roomId;
    this.selfId = joinResponse.participantId;
    this.token = joinResponse.token;
    this.isHost = !!joinResponse.isHost;
    this.slot = joinResponse.slot;
    this.lan = joinResponse.lan || null;
    this.maxParticipants = joinResponse.maxParticipants;
    this.clockOffset = 0;              // serverMs - localMs
    this._listeners = new Map();
    this._es = null;
    this._closed = false;
    this._clockTimer = null;
    this._downSince = 0;
  }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this._listeners.get(type)?.delete(fn);
  }

  _emit(type, data) {
    this._listeners.get(type)?.forEach((fn) => {
      try { fn(data); } catch (e) { console.error("[karaoke]", type, e); }
    });
  }

  get _auth() {
    return { pid: this.selfId, token: this.token };
  }

  _url(path) {
    return routed(this.server, `${this.server}/karaoke/rooms/${encodeURIComponent(this.roomId)}${path}`);
  }

  connect() {
    const qs = new URLSearchParams(this._auth).toString();
    const es = new EventSource(this._url(`/events?${qs}`));
    this._es = es;
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        let data = null;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (type === "snapshot") {
          this._downSince = 0;
          this._emit("connection", "live");
        }
        this._emit(type, data);
        if (type === "closed" || type === "kicked" || type === "bye") this._shutdown();
      });
    }
    es.onerror = () => {
      if (this._closed) return;
      if (es.readyState === EventSource.CLOSED) {
        // The server refused the stream (403/404: room gone or we were dropped). Final.
        this._emit("lost", "room_not_found");
        this._shutdown();
        return;
      }
      if (!this._downSince) this._downSince = Date.now();
      this._emit("connection", "reconnecting");
      // EventSource keeps retrying forever; give up after a minute so a vanished host does
      // not leave guests staring at a spinner.
      if (Date.now() - this._downSince > 60_000) {
        this._emit("lost", "unreachable");
        this._shutdown();
      }
    };
    this.syncClock();
    this._clockTimer = setInterval(() => this.syncClock(), 30_000);
  }

  /**
   * NTP-style offset estimate: a few round trips to /karaoke/time, keep the one with the
   * smallest RTT (least queueing noise). Everyone measures against the same server clock, so
   * the host's "position P at server time T" means the same thing on every machine.
   */
  async syncClock(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      const wall0 = Date.now();
      try {
        const d = await requestJson(routed(this.server, `${this.server}/karaoke/time`), { timeout: 2000 });
        const rtt = performance.now() - t0;
        const offset = d.now - (wall0 + rtt / 2);
        if (!best || rtt < best.rtt) best = { rtt, offset };
      } catch { /* skip sample */ }
    }
    if (best) {
      this.clockOffset = best.offset;
      this.rtt = best.rtt;
      this._emit("clock", best);
    }
    return best;
  }

  serverNow() {
    return Date.now() + this.clockOffset;
  }

  _post(path, body, opts) {
    return requestJson(this._url(path), { method: "POST", body: { ...this._auth, ...body }, ...opts });
  }

  signal(to, data) {
    return this._post("/signal", { to, data }).catch(() => {});
  }

  publishPlayback(state, force = false) {
    return this._post("/playback", { state, force }, { timeout: 3000 }).catch(() => {});
  }

  publishLyrics(payload) {
    return this._post("/lyrics", payload, { timeout: 15000 }).catch(() => {});
  }

  setMic(muted) {
    return this._post("/mic", { muted: !!muted }).catch(() => {});
  }

  kick(target) {
    return this._post("/kick", { target });
  }

  /** Leave the room. Hosts leaving closes it for everyone. Safe to call during unload. */
  leave() {
    if (this._closed) return;
    const url = this._url("/leave");
    const body = JSON.stringify(this._auth);
    let sent = false;
    try {
      // sendBeacon survives the window closing; the server accepts its text/plain body.
      sent = navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" })) || false;
    } catch { /* fall through */ }
    if (!sent) fetch(url, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: true }).catch(() => {});
    this._shutdown();
  }

  _shutdown() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._clockTimer);
    try { this._es?.close(); } catch { /* already closed */ }
    this._emit("shutdown");
  }
}
