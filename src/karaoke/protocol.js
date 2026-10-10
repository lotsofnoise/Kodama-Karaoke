// Live Karaoke Room — shared constants and small pure helpers (no React, no network).
//
// Must agree with python-backend/karaoke_room.py.

export const MAX_PARTICIPANTS = 5;          // host + 4 guests; the server enforces the same cap
export const ROOM_CODE_LEN = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEFAULT_PORT = 9847;           // kodama-server already listens on 0.0.0.0:9847
export const LOCAL_SERVER = `http://localhost:${DEFAULT_PORT}`;

// Default ICE servers. Public STUN is enough for most home networks; symmetric NATs (some
// mobile hotspots, campus networks) need a TURN server, which can be added in the create /
// join modal's advanced field and is stored per device.
export const DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/** Upper-case, drop separators and anything outside the code alphabet ("abc-123" → "ABC123"). */
export function normalizeRoomCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LEN);
}

export function isValidRoomCode(code) {
  if (typeof code !== "string" || code.length !== ROOM_CODE_LEN) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * Turn whatever the user typed for the host into a base URL.
 *   "192.168.1.20"          → "http://192.168.1.20:9847"
 *   "my-pc.tailnet.ts.net"  → "http://my-pc.tailnet.ts.net:9847"
 *   "https://relay.example" → "https://relay.example:9847" (relays run on 9847 too, see CSP)
 *   "[fe80::1]:9847"        → "http://[fe80::1]:9847"
 * Returns "" for empty / unparsable input.
 */
export function normalizeServer(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return "";
    if (!u.port) u.port = String(DEFAULT_PORT);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** Invite string friends paste into "Join by ID": CODE@host (port omitted when default). */
export function buildInvite(code, server) {
  if (!server) return code;
  try {
    const u = new URL(server);
    // hostname keeps the [] around IPv6 literals. An explicit :80/:443 is normalised away by
    // URL, so put it back — the joiner would otherwise assume 9847.
    const host = u.port === String(DEFAULT_PORT)
      ? u.hostname
      : (u.port ? u.host : `${u.hostname}:${u.protocol === "https:" ? 443 : 80}`);
    return `${code}@${u.protocol === "https:" ? "https://" : ""}${host}`;
  } catch {
    return code;
  }
}

/**
 * Parse a pasted invite. Accepts:
 *   "ABC234"                     → { code }
 *   "abc-234@192.168.1.20"       → { code, server }
 *   "ABC234@https://relay.x:9847"
 *   "kodama://karaoke/ABC234?server=192.168.1.20"
 */
export function parseInvite(raw) {
  const s = String(raw || "").trim();
  if (!s) return { code: "", server: "" };
  const deep = s.match(/^kodama:\/\/karaoke\/([^?#/]+)(?:\?(.*))?$/i);
  if (deep) {
    const params = new URLSearchParams(deep[2] || "");
    return { code: normalizeRoomCode(deep[1]), server: normalizeServer(params.get("server") || "") };
  }
  const at = s.indexOf("@");
  if (at > 0) {
    return { code: normalizeRoomCode(s.slice(0, at)), server: normalizeServer(s.slice(at + 1)) };
  }
  return { code: normalizeRoomCode(s), server: "" };
}

/** Stable per-slot hue so a person keeps their colour across the overlay and the full view. */
export const SLOT_HUES = [322, 200, 140, 38, 268];

/** Strip a track object down to what guests need to play the same song. */
export function slimTrack(t) {
  if (!t?.videoId) return null;
  const artists = Array.isArray(t.artists)
    ? t.artists.map((a) => (a && a.name) || a).filter(Boolean).join(", ")
    : (t.artists || "");
  return {
    videoId: String(t.videoId),
    title: String(t.title || ""),
    artists,
    album: typeof t.album === "string" ? t.album : (t.album?.name || ""),
    thumbnail: String(t.thumbnail || ""),
    duration: t.duration ?? "",
  };
}

/**
 * Keep only what the karaoke renderer reads from parsed lyric lines — timing and words. Drops
 * DOM-ish or provider-specific baggage so the payload that crosses the network stays small.
 */
export function slimLyricLines(lines) {
  if (!Array.isArray(lines)) return [];
  const w = (x) => ({ text: String(x.text ?? ""), time: +x.time || 0, end: +x.end || +x.time || 0, isSpace: !!x.isSpace });
  return lines
    .filter((l) => l && typeof l.time === "number")
    .map((l) => {
      const out = { time: l.time, text: typeof l.text === "string" ? l.text : "" };
      if (typeof l.endTime === "number") out.endTime = l.endTime;
      if (l.wordSync && Array.isArray(l.words) && l.words.length) {
        out.words = l.words.map(w);
        if (!out.text) out.text = out.words.map((x) => x.text).join("");
      }
      if (Array.isArray(l.bgWords) && l.bgWords.length) out.bgWords = l.bgWords.map(w);
      if (l.agentRole) out.agentRole = l.agentRole;
      return out;
    });
}

/** Index of the line that is active at time `t` (seconds), or -1 before the first line. */
export function activeLineIndex(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 0..1 fill of a single word at time t. */
export function wordProgress(word, t) {
  if (t <= word.time) return 0;
  const end = word.end > word.time ? word.end : word.time + 0.25;
  if (t >= end) return 1;
  return (t - word.time) / (end - word.time);
}
