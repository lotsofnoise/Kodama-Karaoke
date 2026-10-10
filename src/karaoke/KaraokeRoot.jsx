// Live Karaoke Room — everything App mounts once: the modals, the floating overlay, and the
// toasts for entering / leaving a room.

import { useEffect, useRef } from "react";
import { useLang } from "../context.jsx";
import { karaoke, useKaraoke } from "./session.js";
import { KaraokeModalHost } from "./KaraokeModals.jsx";
import { KaraokeOverlay } from "./KaraokeOverlay.jsx";
import { endReasonKey } from "./KaraokeView.jsx";

export function KaraokeRoot({ view, onOpenRoom, addToast, suppressed = false }) {
  const t = useLang();
  const state = useKaraoke();
  const lastEnd = useRef(null);

  // Tell the user why a room ended, wherever they are in the app.
  useEffect(() => {
    if (state.endReason && state.endReason !== lastEnd.current) {
      addToast?.(t(endReasonKey(state.endReason)), state.endReason === "kicked" ? "error" : "info");
    }
    lastEnd.current = state.endReason;
  }, [state.endReason, addToast, t]);

  const onDone = (kind) => {
    addToast?.(t(kind === "created" ? "karaokeCreated" : "karaokeJoined", { code: karaoke.state.roomId || "" }), "success");
    onOpenRoom?.();
  };

  return (
    <>
      <KaraokeModalHost onDone={onDone} />
      <KaraokeOverlay hidden={suppressed || view === "karaoke"} onOpenRoom={onOpenRoom} addToast={addToast} />
    </>
  );
}
