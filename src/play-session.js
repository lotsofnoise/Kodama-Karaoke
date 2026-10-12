// Saved play state, one per profile: the queue, the current song, where in it, shuffle and
// repeat. Kept in localStorage like History, and given back paused when Kodama opens, when the
// profile changes, and when a karaoke guest or a Listen Together listener leaves a room.
//
// Only a user's OWN music is saved. While this Kodama follows someone else's room - a karaoke
// guest, or a Listen Together listener - its player holds that room's song, so nothing is
// written and the copy from before joining stays as it was.

import { karaoke } from "./karaoke/session.js";
import { isRoomListener } from "./together/together.js";

const MAX_QUEUE = 1000;
const keyFor = (profile) => `kiyoshi-session-${profile}`;
// The position changes every second, so it is kept apart from the (possibly long) queue and is
// cheap to write that often. Kodama can be quit without the page getting to say goodbye, so a
// once-a-second save is what makes "the exact spot" hold.
const posKeyFor = (profile) => `kiyoshi-session-pos-${profile}`;

// The profile whose session is in the player right now. Null until one has been restored, so
// nothing is saved over a profile before its own session was loaded.
let owner = null;

export const isKaraokeGuest = () => {
  const s = karaoke.getSnapshot();
  return s.phase === "in-room" && !s.isHost;
};

/** Following someone else's room: the player holds their song, not this user's music. */
export const isFollowingRoom = () => isKaraokeGuest() || isRoomListener();

export function canSave() {
  return !!owner && owner === window.__activeProfile && !isFollowingRoom();
}

export function readSession(profile) {
  if (!profile) return null;
  try {
    const s = JSON.parse(localStorage.getItem(keyFor(profile)) || "null");
    if (!s) return null;
    const p = JSON.parse(localStorage.getItem(posKeyFor(profile)) || "null");
    // Only the spot in the song that was saved for THIS song counts.
    s.position = p && s.track?.videoId && p.videoId === s.track.videoId ? Number(p.position) || 0 : 0;
    return s;
  } catch { return null; }
}

/** Save where in `videoId` playback is, if saving is allowed right now. */
export function writePosition(videoId, position) {
  if (!canSave() || !videoId) return;
  try { localStorage.setItem(posKeyFor(owner), JSON.stringify({ videoId, position: Math.max(0, position || 0) })); } catch { /* ignore */ }
}

// A very long queue is cut down to MAX_QUEUE songs, keeping the current one and what follows it.
function capQueue(queue, track) {
  if (queue.length <= MAX_QUEUE) return queue;
  const i = track?.videoId ? queue.findIndex((x) => x.videoId === track.videoId) : -1;
  const start = i < 0 ? 0 : Math.max(0, Math.min(i - 50, queue.length - MAX_QUEUE));
  return queue.slice(start, start + MAX_QUEUE);
}

/** Merge `patch` into the owner's saved session, if saving is allowed right now. */
export function writeSession(patch) {
  if (!canSave()) return;
  try {
    const { position: _p, ...cur } = readSession(owner) || {};
    const next = { ...cur, ...patch, savedAt: Date.now() };
    if (Array.isArray(next.queue)) next.queue = capQueue(next.queue, next.track);
    localStorage.setItem(keyFor(owner), JSON.stringify(next));
  } catch { /* storage full or unavailable: keep playing */ }
}

/** A deleted profile's saved play state goes with it. */
export function forgetSession(profile) {
  if (!profile) return;
  try { localStorage.removeItem(keyFor(profile)); localStorage.removeItem(posKeyFor(profile)); } catch { /* ignore */ }
  if (owner === profile) owner = null;
}

export const getOwner = () => owner;
export function setOwner(profile) { owner = profile || null; }
