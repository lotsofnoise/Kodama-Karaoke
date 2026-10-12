// Live Karaoke Room — the "Karaoke Room" tab.
//
// Not in a room: two entry cards (Create a room / Join by ID) and what to expect.
// In a room: the room code + invite, the five seats with per-person controls, and a large
// word-synced lyrics stage for the song the host is playing.

import { Button } from "@heroui/react";
import { useLang, thumb, coverOf } from "../context.jsx";
import { MicrophoneStand, Users, Plus, ArrowRight, Copy, DoorOpen, Headphones, WifiHigh, WifiX, Lock, WarningCircle } from "../icons.jsx";
import { Toggle } from "../ui/settings-controls.jsx";
import { karaoke, useKaraoke } from "./session.js";
import { openKaraokeModal } from "./KaraokeModals.jsx";
import { copyInvite } from "./KaraokeOverlay.jsx";
import { SeatGrid } from "./KaraokeSlots.jsx";
import { KaraokeLyrics } from "./KaraokeLyrics.jsx";
import { MicCheck } from "./MicCheck.jsx";
import "./karaoke.css";

const END_KEYS = {
  closed: "karaokeEndedClosed",
  host_left: "karaokeEndedClosed",
  replaced: "karaokeEndedClosed",
  empty: "karaokeEndedClosed",
  kicked: "karaokeEndedKicked",
  unreachable: "karaokeEndedLost",
  room_not_found: "karaokeEndedLost",
  timeout: "karaokeEndedLost",
};
export const endReasonKey = (r) => END_KEYS[r] || "karaokeEndedLost";

function Header({ children }) {
  const t = useLang();
  return (
    <div className="flex items-start gap-4 mb-7">
      <div className="kk-entry-icon" style={{ width: 54, height: 54, borderRadius: 18, fontSize: 24 }}>
        <MicrophoneStand size={24} />
      </div>
      <div className="flex-1 min-w-0">
        <h1 className="text-[28px] font-bold leading-tight m-0">{t("karaokeRoom")}</h1>
        <p className="text-secondary text-[length:var(--t14,14px)] mt-1.5 mb-0 max-w-[620px] leading-relaxed">{t("karaokeTagline")}</p>
      </div>
      {children}
    </div>
  );
}

function Lobby({ state }) {
  const t = useLang();
  return (
    <>
      <Header />
      {state.endReason && (
        <div className="kk-card flex items-center gap-3 mb-5" style={{ background: "var(--status-info-soft)", color: "var(--status-info)" }}>
          <WarningCircle size={16} />
          <span className="flex-1 text-[length:var(--t13)]">{t(endReasonKey(state.endReason))}</span>
          <button type="button" className="kk-icon-btn" onClick={() => karaoke.clearEndReason()} aria-label={t("close")}>×</button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 max-w-[860px]">
        <button type="button" className="kk-card kk-entry" onClick={() => openKaraokeModal("create")}>
          <span className="kk-entry-icon"><Plus size={20} weight="bold" /></span>
          <span className="text-[18px] font-bold">{t("karaokeCreateRoom")}</span>
          <span className="text-secondary text-[length:var(--t13)] leading-relaxed">{t("karaokeCreateDesc")}</span>
          <span className="flex items-center gap-1.5 text-accent text-[length:var(--t13)] font-semibold mt-1">{t("karaokeCreate")} <ArrowRight size={12} /></span>
        </button>
        <button type="button" className="kk-card kk-entry" onClick={() => openKaraokeModal("join")}>
          <span className="kk-entry-icon"><Users size={20} /></span>
          <span className="text-[18px] font-bold">{t("karaokeJoinRoom")}</span>
          <span className="text-secondary text-[length:var(--t13)] leading-relaxed">{t("karaokeJoinDesc")}</span>
          <span className="flex items-center gap-1.5 text-accent text-[length:var(--t13)] font-semibold mt-1">{t("karaokeJoin")} <ArrowRight size={12} /></span>
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mt-6">
        <span className="kk-chip"><Users size={12} />{t("karaokeMax5")}</span>
        <span className="kk-chip"><Lock size={12} />{t("karaokeVoiceP2P")}</span>
        <span className="kk-chip"><MicrophoneStand size={12} />{t("karaokeNoTextChat")}</span>
        <span className="kk-chip"><Headphones size={12} />{t("karaokeHeadphonesHint")}</span>
      </div>
      <div className="max-w-[860px]"><MicCheck /></div>
    </>
  );
}

function Room({ state, addToast }) {
  const t = useLang();
  const track = state.playback?.track;
  return (
    <>
      <Header>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="ghost" onPress={() => karaoke.leave()} className="text-[color:var(--status-danger)]!">
            <DoorOpen size={14} /> {state.isHost ? t("karaokeCloseRoom") : t("karaokeLeave")}
          </Button>
        </div>
      </Header>

      {/* room code + invite */}
      <div className="kk-card flex flex-wrap items-center gap-x-6 gap-y-3 mb-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{t("karaokeRoomId")}</div>
          <div className="kk-code text-[30px] leading-tight">{state.roomId}</div>
        </div>
        <Button variant="secondary" onPress={() => copyInvite(state, addToast, t)}>
          <Copy size={13} /> {t("karaokeCopyInvite")}
        </Button>
        {state.isHost && state.lanInvites.length > 0 && (
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{t("karaokeLanAddresses")}</div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {state.lanInvites.map((inv) => <span key={inv} className="kk-chip kk-code" style={{ letterSpacing: "0.04em" }}>{inv}</span>)}
            </div>
          </div>
        )}
        <div className="flex-1" />
        <span className="kk-chip" style={state.connection !== "live" ? { color: "var(--status-warning)" } : undefined}>
          {state.connection === "live" ? <WifiHigh size={12} /> : <WifiX size={12} />}
          {state.connection === "live"
            ? `${t("karaokeSeats", { n: state.participants.length, max: state.maxParticipants })}${state.rttMs != null ? ` · ${state.rttMs} ms` : ""}`
            : t("karaokeReconnecting")}
        </span>
      </div>

      {/* seats */}
      <SeatGrid state={state} />

      {(state.micState === "blocked" || state.micState === "unsupported") && (
        <div className="kk-card flex items-center gap-3 mt-4" style={{ background: "var(--status-warning-soft)", color: "var(--status-warning)" }}>
          <WarningCircle size={16} />
          <span className="flex-1 text-[length:var(--t13)]">{state.micState === "blocked" ? t("karaokeMicBlocked") : t("karaokeMicUnsupported")}</span>
          {state.micState === "blocked" && <Button size="sm" variant="secondary" onPress={() => karaoke.startMic()}>{t("karaokeMicRetry")}</Button>}
        </div>
      )}

      {/* stage: now playing + lyrics */}
      <div className="kk-stage mt-4">
        <div className="flex items-center gap-3 mb-2">
          {coverOf(track) && <img src={thumb(coverOf(track))} alt="" className="w-12 h-12 rounded-lg object-cover" />}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{t("karaokeNowSinging")}</div>
            <div className="text-[length:var(--t15,15px)] font-semibold truncate">{track ? track.title : "—"}</div>
            {track && <div className="text-[length:var(--t13)] text-secondary truncate">{track.artists}</div>}
          </div>
          {state.lyrics?.source && <span className="kk-chip">{state.lyrics.source}</span>}
        </div>
        <KaraokeLyrics lyrics={state.lyrics} offset={state.playback?.lyricsOffset || 0} variant="full" waiting={!track} />
        <div className="text-[length:var(--t12)] text-muted mt-2">
          {state.isHost ? t("karaokeHostPlayHint") : t("karaokeGuestHint")}
        </div>
      </div>

      <MicCheck />

      {/* settings */}
      <div className="kk-card flex items-center gap-4 mt-4">
        <div className="flex-1 min-w-0">
          <div className="text-[length:var(--t14,14px)] font-semibold">{t("karaokeSingingMode")}</div>
          <div className="text-[length:var(--t12)] text-muted">{t("karaokeSingingModeDesc")}</div>
        </div>
        <Toggle value={state.singingMode} onChange={(v) => karaoke.setSingingMode(v)} aria-label={t("karaokeSingingMode")} />
      </div>
      <div className="flex items-center gap-2 mt-3 text-[length:var(--t12)] text-muted">
        <Headphones size={12} /> {t("karaokeHeadphonesHint")}
      </div>
    </>
  );
}

export function KaraokeView({ addToast }) {
  const t = useLang();
  const state = useKaraoke();
  return (
    <div className="px-8 pt-8 pb-10" style={{ maxWidth: 1100 }}>
      {state.phase === "in-room"
        ? <Room state={state} addToast={addToast} />
        : state.phase === "connecting"
          ? (<><Header /><div className="flex items-center gap-2 text-secondary"><span className="kk-spinner" />{t("karaokeConnecting")}</div></>)
          : <Lobby state={state} />}
    </div>
  );
}
