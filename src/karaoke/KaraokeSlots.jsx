// Live Karaoke Room — the five participant slots (compact strip for the overlay, cards for
// the full room page) and the per-person controls.

import { cn } from "@heroui/react";
import { useLang } from "../context.jsx";
import { Crown, Microphone, MicrophoneSlash, SpeakerX, SpeakerHigh, UserMinus } from "../icons.jsx";
import { Slider } from "../ui/settings-controls.jsx";
import { karaoke, useKaraokeLevels } from "./session.js";
import { MAX_PARTICIPANTS, SLOT_HUES } from "./protocol.js";

/** Seat list with empty seats filled in, always exactly MAX_PARTICIPANTS long, by slot. */
export function seatsOf(participants) {
  const seats = Array.from({ length: MAX_PARTICIPANTS }, () => null);
  for (const p of participants) if (p.slot >= 0 && p.slot < MAX_PARTICIPANTS) seats[p.slot] = p;
  return seats;
}

const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/** Avatar with a live voice-level ring. Subscribes to levels itself so only it re-renders 10×/s. */
export function Avatar({ participant, slot, size = 40, isSelf, micMuted, peerState }) {
  const levels = useKaraokeLevels();
  if (!participant) {
    return <div className="kk-avatar is-empty" style={{ width: size, height: size, fontSize: size * 0.34 }}>{slot + 1}</div>;
  }
  const muted = isSelf ? micMuted : participant.muted;
  const level = muted ? 0 : (levels[participant.id] || 0);
  const offline = !participant.connected || (!isSelf && peerState && peerState !== "connected" && peerState !== "new" && peerState !== "connecting");
  return (
    <div
      className={cn("kk-avatar", offline && "is-offline")}
      style={{ width: size, height: size, fontSize: size * 0.36, "--hue": SLOT_HUES[slot % SLOT_HUES.length], "--lvl": level.toFixed(3) }}
    >
      {initials(participant.name)}
      {participant.isHost && <span className="kk-badge host"><Crown size={9} weight="fill" /></span>}
      <span className={cn("kk-badge mic", muted && "is-muted")}>
        {muted ? <MicrophoneSlash size={9} weight="fill" /> : <Microphone size={9} weight="fill" />}
      </span>
      {!isSelf && peerState && (peerState === "new" || peerState === "connecting") && (
        <span className="kk-badge" style={{ right: -3, top: -3, width: 14, height: 14 }}><span className="kk-spinner" style={{ width: 8, height: 8 }} /></span>
      )}
    </div>
  );
}

/**
 * Controls for one person. For yourself: your mic. For others: mute-for-me + volume (0–200%),
 * and — for the host — remove from room. All local, except your own mic state, which everyone
 * sees on your avatar.
 */
export function SeatControls({ participant, state, layout = "row" }) {
  const t = useLang();
  if (!participant) return null;
  const isSelf = participant.id === state.selfId;
  if (isSelf) {
    const live = state.micState === "live";
    return (
      <div className={cn("flex items-center gap-2", layout === "column" && "flex-col")}>
        <button
          type="button"
          className={cn("kk-icon-btn", live && !state.micMuted ? "is-on" : "is-off")}
          onClick={() => karaoke.toggleMic()}
          title={!live ? t("karaokeMicRetry") : state.micMuted ? t("karaokeUnmuteMic") : t("karaokeMuteMic")}
          aria-pressed={live && !state.micMuted}
        >
          {live && !state.micMuted ? <Microphone size={14} weight="fill" /> : <MicrophoneSlash size={14} weight="fill" />}
        </button>
        {layout === "row" && (
          <span className="text-[length:var(--t12,12px)] text-secondary">
            {!live ? t("karaokeMicRetry") : state.micMuted ? t("karaokeUnmuteMic") : t("karaokeMuteMic")}
          </span>
        )}
      </div>
    );
  }
  const pref = state.peerPrefs[participant.id] || { volume: 1, muted: false };
  return (
    <div className={cn("flex items-center gap-2 min-w-0", layout === "column" && "flex-col")}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={cn("kk-icon-btn", pref.muted && "is-off")}
          onClick={() => karaoke.togglePeerMuted(participant.id)}
          title={pref.muted ? t("karaokeUnmuteForMe") : t("karaokeMuteForMe")}
          aria-pressed={pref.muted}
        >
          {pref.muted ? <SpeakerX size={14} weight="fill" /> : <SpeakerHigh size={14} weight="fill" />}
        </button>
        {state.isHost && (
          <button type="button" className="kk-icon-btn is-danger" onClick={() => karaoke.kick(participant.id)} title={t("karaokeKick")}>
            <UserMinus size={13} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <Slider
          min={0} max={2} step={0.05}
          value={pref.muted ? 0 : pref.volume}
          onChange={(v) => {
            if (pref.muted && v > 0) karaoke.togglePeerMuted(participant.id);
            karaoke.setPeerVolume(participant.id, v);
          }}
          width={layout === "column" ? 96 : 150}
          aria-label={`${t("karaokeVolume")} – ${participant.name}`}
        />
        <span className="text-[11px] tabular-nums text-muted w-9 text-end">{Math.round((pref.muted ? 0 : pref.volume) * 100)}%</span>
      </div>
    </div>
  );
}

/** Compact strip of 5 seats for the floating overlay. Clicking a seat selects it. */
export function SeatStrip({ state, selected, onSelect }) {
  const t = useLang();
  return (
    <div className="grid grid-cols-5 gap-1">
      {seatsOf(state.participants).map((p, slot) => {
        const isSelf = p?.id === state.selfId;
        return (
          <button
            key={slot}
            type="button"
            className={cn("kk-slot-btn", selected === p?.id && p && "is-selected")}
            disabled={!p}
            onClick={() => p && onSelect(selected === p.id ? null : p.id)}
            title={p ? p.name : t("karaokeOpenSeat")}
          >
            <Avatar participant={p} slot={slot} size={38} isSelf={isSelf} micMuted={state.micMuted} peerState={p && state.peerStates[p.id]} />
            <span className="kk-slot-name">{p ? (isSelf ? t("karaokeYou") : p.name) : t("karaokeOpenSeat")}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Five big seat cards for the room page, controls inline. */
export function SeatGrid({ state }) {
  const t = useLang();
  return (
    <div className="kk-seat-grid">
      {seatsOf(state.participants).map((p, slot) => {
        const isSelf = p?.id === state.selfId;
        return (
          <div key={slot} className={cn("kk-seat", !p && "is-empty")}>
            <Avatar participant={p} slot={slot} size={64} isSelf={isSelf} micMuted={state.micMuted} peerState={p && state.peerStates[p.id]} />
            <div className="text-center min-w-0 w-full">
              <div className="text-[length:var(--t14,14px)] font-semibold truncate">
                {p ? p.name : t("karaokeOpenSeat")}
              </div>
              <div className="text-[11px] text-muted h-4">
                {p && (isSelf ? t("karaokeYou") : p.isHost ? t("karaokeHost") : "")}
                {p && isSelf && p.isHost && ` · ${t("karaokeHost")}`}
              </div>
            </div>
            {p && <SeatControls participant={p} state={state} layout="column" />}
          </div>
        );
      })}
    </div>
  );
}
