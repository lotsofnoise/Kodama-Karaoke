// Live Karaoke Room — the compact floating room overlay.
//
// Visible on every page while you are in a room (the Karaoke Room page shows the full version
// instead). Shows the five seats with live mic levels and mute states, per-person controls on
// click, and the current + next lyric line with word-by-word fill. Draggable by its header,
// collapsible to a pill; position and collapsed state persist.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@heroui/react";
import { useLang, thumb, coverOf } from "../context.jsx";
import { MicrophoneStand, Microphone, MicrophoneSlash, ArrowsOut, Minus, DoorOpen, Copy, WifiX } from "../icons.jsx";
import { karaoke, useKaraoke } from "./session.js";
import { SeatStrip, SeatControls, Avatar, seatsOf } from "./KaraokeSlots.jsx";
import { KaraokeLyrics } from "./KaraokeLyrics.jsx";
import "./karaoke.css";

export async function copyInvite(state, addToast, t) {
  const text = state.invite || state.roomId || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* nothing else to try */ }
    ta.remove();
  }
  addToast?.(`${t("karaokeCopied")}: ${text}`, "success");
}

const DEFAULT_POS = { right: 20, bottom: 120 };

export function KaraokeOverlay({ hidden, onOpenRoom, addToast }) {
  const t = useLang();
  const state = useKaraoke();
  const [prefs, setPrefs] = useState(() => karaoke.overlayPrefs);
  const [selected, setSelected] = useState(null);
  const boxRef = useRef(null);
  const drag = useRef(null);

  const savePrefs = useCallback((next) => {
    setPrefs(next);
    karaoke.saveOverlayPrefs(next);
  }, []);

  // Keep a dragged overlay on screen when the window shrinks.
  useEffect(() => {
    const clamp = () => {
      const el = boxRef.current;
      if (!el || prefs.x == null) return;
      const maxX = window.innerWidth - el.offsetWidth - 8;
      const maxY = window.innerHeight - el.offsetHeight - 8;
      if (prefs.x > maxX || prefs.y > maxY) savePrefs({ ...prefs, x: Math.max(8, Math.min(prefs.x, maxX)), y: Math.max(8, Math.min(prefs.y, maxY)) });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [prefs, savePrefs]);

  // Forget a selection whose person left.
  useEffect(() => {
    if (selected && !state.participants.some((p) => p.id === selected)) setSelected(null);
  }, [state.participants, selected]);

  if (state.phase !== "in-room" || hidden) return null;

  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = boxRef.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const el = boxRef.current;
    const x = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - el.offsetWidth - 8));
    const y = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - el.offsetHeight - 8));
    d.moved = true;
    el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.right = "auto"; el.style.bottom = "auto";
    d.x = x; d.y = y;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) savePrefs({ ...prefs, x: d.x, y: d.y });
  };

  const posStyle = prefs.x == null ? DEFAULT_POS : { left: prefs.x, top: prefs.y };
  const handle = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
  const me = state.participants.find((p) => p.id === state.selfId);
  const micLive = state.micState === "live" && !state.micMuted;
  const track = state.playback?.track;
  const selectedP = state.participants.find((p) => p.id === selected);

  const micButton = (
    <button
      type="button"
      className={cn("kk-icon-btn", micLive ? "is-on" : "is-off")}
      onClick={() => karaoke.toggleMic()}
      title={state.micState !== "live" ? t("karaokeMicRetry") : state.micMuted ? t("karaokeUnmuteMic") : t("karaokeMuteMic")}
      aria-pressed={micLive}
    >
      {micLive ? <Microphone size={14} weight="fill" /> : <MicrophoneSlash size={14} weight="fill" />}
    </button>
  );

  if (prefs.collapsed) {
    return (
      <div ref={boxRef} className="kk-overlay is-collapsed" style={posStyle} role="region" aria-label={t("karaokeRoom")}>
        <div className="kk-handle flex items-center gap-2 p-1.5 pe-2" {...handle}>
          {micButton}
          <span className="kk-code text-[13px]">{state.roomId}</span>
          <div className="flex items-center gap-1.5 ps-1">
            {seatsOf(state.participants).map((p, slot) => (
              <Avatar key={slot} participant={p} slot={slot} size={20} isSelf={p?.id === state.selfId} micMuted={state.micMuted} peerState={p && state.peerStates[p.id]} />
            ))}
          </div>
          <button type="button" className="kk-icon-btn" onClick={() => savePrefs({ ...prefs, collapsed: false })} title={t("karaokeExpand")}>
            <ArrowsOut size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="kk-overlay" style={posStyle} role="region" aria-label={t("karaokeRoom")}>
      {/* header / drag handle */}
      <div className="kk-handle flex items-center gap-2 ps-4 pe-2 pt-2.5 pb-1.5" {...handle}>
        <MicrophoneStand size={15} className="text-accent" />
        <button type="button" className="kk-chip border-none cursor-pointer" onClick={() => copyInvite(state, addToast, t)} title={t("karaokeCopyInvite")}>
          <span className="kk-code">{state.roomId}</span>
          <Copy size={11} />
        </button>
        {state.connection !== "live" ? (
          <span className="kk-chip" style={{ color: "var(--status-warning)" }}><WifiX size={11} />{t("karaokeReconnecting")}</span>
        ) : (
          <span className="text-[11px] text-muted whitespace-nowrap">
            {t("karaokeSeats", { n: state.participants.length, max: state.maxParticipants })}
          </span>
        )}
        <div className="flex-1" />
        {micButton}
        <button type="button" className="kk-icon-btn" onClick={onOpenRoom} title={t("karaokeOpenRoom")}><ArrowsOut size={13} /></button>
        <button type="button" className="kk-icon-btn" onClick={() => savePrefs({ ...prefs, collapsed: true })} title={t("karaokeCollapse")}><Minus size={13} /></button>
        <button type="button" className="kk-icon-btn is-danger" onClick={() => karaoke.leave()} title={state.isHost ? t("karaokeCloseRoom") : t("karaokeLeave")}><DoorOpen size={13} /></button>
      </div>

      {/* five seats */}
      <div className="px-2.5">
        <SeatStrip state={state} selected={selected} onSelect={setSelected} />
      </div>
      {selectedP && (
        <div className="mx-3 mt-1 mb-1 px-2.5 py-2 rounded-2xl flex items-center gap-3" style={{ background: "var(--fill-subtle, rgba(255,255,255,.05))" }}>
          <span className="text-[12px] font-semibold truncate max-w-[90px]">{selectedP.id === state.selfId ? t("karaokeYou") : selectedP.name}</span>
          <SeatControls participant={selectedP} state={state} />
        </div>
      )}
      {(state.micState === "blocked" || state.micState === "unsupported") && me && (
        <div className="mx-3 mt-1 text-[11px] leading-snug" style={{ color: "var(--status-warning)" }}>
          {state.micState === "blocked" ? t("karaokeMicBlocked") : t("karaokeMicUnsupported")}
        </div>
      )}

      {/* now singing + lyrics */}
      <div className="mt-2 px-4 pt-3 pb-4" style={{ borderTop: "1px solid var(--stroke-dim, var(--border))" }}>
        {track && (
          <div className="flex items-center gap-2.5 mb-2 min-w-0">
            {coverOf(track) && <img src={thumb(coverOf(track))} alt="" className="w-8 h-8 rounded-md object-cover shrink-0" />}
            <div className="min-w-0">
              <div className="text-[12px] font-semibold truncate">{track.title}</div>
              <div className="text-[11px] text-muted truncate">{track.artists}</div>
            </div>
          </div>
        )}
        <KaraokeLyrics
          lyrics={state.lyrics}
          offset={state.playback?.lyricsOffset || 0}
          variant="compact"
          waiting={!track}
        />
      </div>
    </div>
  );
}
