// Song details a track came without: its length, album and artists.
//
// YouTube leaves these out for many songs depending on where they come from (the "All" search
// tab, radio and autoplay picks, uploads): lists showed "—", playlist totals came out short, and
// anything that needs them (the Last.fm scrobble point, the YouTube Music history sync) skipped
// the song. Two sources fill them in, remembered here per video and used wherever a song is
// shown or scrobbled:
//   - the player, which knows a song's length once its audio is loaded;
//   - the server, which looks up the song's full details (what the Songs search tab shows).
// Kept in localStorage, so a song completed once stays complete after a restart.
import { useSyncExternalStore } from "react";

const KEY = "kodama-durations";
const MAX = 3000;

// videoId -> { d: seconds, album, albumBrowseId, artists, artistLinks, artistBrowseId }.
// Older entries were a plain number of seconds.
let known = {};
try { known = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { known = {}; }
let version = 0;
const listeners = new Set();
const entry = (id) => {
  const e = id ? known[id] : null;
  return typeof e === "number" ? { d: e } : (e || null);
};

function save() {
  const ids = Object.keys(known);
  if (ids.length > MAX) ids.slice(0, ids.length - MAX).forEach((id) => delete known[id]);
  try { localStorage.setItem(KEY, JSON.stringify(known)); } catch { /* storage full: still known this session */ }
  version++;
  listeners.forEach((l) => l());
}

/** "3:15" (or "1:02:03") from seconds. */
export function formatSeconds(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s <= 0) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Seconds from "3:15" / "1:02:03" / a number; 0 when there is none. */
export function toSeconds(v) {
  if (typeof v === "number") return v > 0 && isFinite(v) ? v : 0;
  if (typeof v !== "string" || !v.trim()) return 0;
  const parts = v.trim().split(":").map(Number);
  if (parts.some((n) => isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const hasArtists = (a) => (Array.isArray(a) ? a.length > 0 : typeof a === "string" && a.trim() !== "");
const hasText = (v) => typeof v === "string" && v.trim() !== "";

/** The player measured this song: remember its length. */
export function rememberDuration(videoId, seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!videoId || s <= 0) return;
  const e = entry(videoId) || {};
  if (e.d === s) return;
  known[videoId] = { ...e, d: s };
  save();
}

/** The server looked the song up: remember what it found (only what is actually there). */
export function rememberMeta(videoId, meta) {
  if (!videoId || !meta) return;
  const e = { ...(entry(videoId) || {}) };
  let changed = false;
  const set = (k, v) => { if (v && JSON.stringify(e[k]) !== JSON.stringify(v)) { e[k] = v; changed = true; } };
  const secs = toSeconds(meta.duration);
  if (secs && !e.d) set("d", Math.round(secs));
  if (hasText(meta.album)) set("album", meta.album);
  if (hasText(meta.albumBrowseId)) set("albumBrowseId", meta.albumBrowseId);
  if (hasArtists(meta.artists)) set("artists", meta.artists);
  if (Array.isArray(meta.artistLinks) && meta.artistLinks.length) set("artistLinks", meta.artistLinks);
  if (hasText(meta.artistBrowseId)) set("artistBrowseId", meta.artistBrowseId);
  if (!changed) return;
  known[videoId] = e;
  save();
}

/** The track with whatever it came without filled in from what is known. Its own values win. */
export function withMeta(t) {
  const e = entry(t?.videoId);
  if (!t || !e) return t;
  const out = { ...t };
  if (!toSeconds(t.duration) && e.d) out.duration = formatSeconds(e.d);
  if (!albumOf({ album: t.album }) && e.album) { out.album = e.album; if (!t.albumBrowseId && e.albumBrowseId) out.albumBrowseId = e.albumBrowseId; }
  if (!hasArtists(t.artists) && e.artists) {
    out.artists = e.artists;
    if (e.artistLinks && !(Array.isArray(t.artistLinks) && t.artistLinks.length)) out.artistLinks = e.artistLinks;
    if (!t.artistBrowseId && e.artistBrowseId) out.artistBrowseId = e.artistBrowseId;
  }
  return out;
}

/** A track's length in seconds: its own, else a known one, else 0. */
export const durationSecondsOf = (t) => toSeconds(t?.duration) || entry(t?.videoId)?.d || 0;

/** A track's length as shown in lists ("3:15"), or "" when nobody knows it yet. */
export function durationOf(t) {
  if (typeof t?.duration === "string" && t.duration.trim()) return t.duration;
  return formatSeconds(durationSecondsOf(t));
}

/** A track's album name, whatever shape it came in, else a known one, else "". */
export function albumOf(t) {
  const a = t?.album;
  const own = typeof a === "string" ? a : (a && typeof a === "object" ? a.name || "" : "");
  return own || entry(t?.videoId)?.album || "";
}

/** Does this track still lack something worth looking up (length, album or artists)? */
export const isIncomplete = (t) => !!t?.videoId && (!durationSecondsOf(t) || !albumOf(t) || !hasArtists(withMeta(t).artists));

/** Re-render when newly found details arrive (lists showing "—" fill in by themselves). */
export function useKnownDurations() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => version,
  );
}
