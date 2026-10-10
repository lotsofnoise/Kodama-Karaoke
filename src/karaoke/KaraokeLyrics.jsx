// Live Karaoke Room — word/syllable-synced lyrics.
//
// React renders a line only when the active line changes; the per-word fill runs in a rAF loop
// that writes a CSS variable (--p, 0..1) straight onto each word's span. The clock is
// karaoke.songTime(): this machine's own player when it is on the room's song (the follower
// keeps it on the host's playhead), otherwise the host's extrapolated position.

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@heroui/react";
import { useLang } from "../context.jsx";
import { karaoke } from "./session.js";
import { activeLineIndex, wordProgress } from "./protocol.js";

function Line({ line, index, state, registerWords, style, onRef }) {
  const words = line.words;
  return (
    <div
      ref={onRef}
      className={cn("kk-line", !words && "line-sync", state === "active" && "is-active", state === "past" && "is-past", state === "next" && "is-next")}
      style={style}
      data-line={index}
    >
      {words
        ? words.map((w, i) => (
          <span key={i} className="kk-word" ref={(el) => registerWords(index, "w", i, el)}>{w.text}</span>
        ))
        : (line.text || " ")}
      {Array.isArray(line.bgWords) && line.bgWords.length > 0 && (
        <span className="kk-bg">
          {line.bgWords.map((w, i) => (
            <span key={i} className="kk-word" ref={(el) => registerWords(index, "b", i, el)}>{w.text}</span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * @param {{ lyrics: {status:string, lines:any[]}|null, offset?: number, variant?: "compact"|"full", waiting?: boolean }} props
 */
export function KaraokeLyrics({ lyrics, offset = 0, variant = "compact", waiting = false }) {
  const t = useLang();
  const lines = useMemo(() => lyrics?.lines || [], [lyrics]);
  const [idx, setIdx] = useState(-1);
  const idxRef = useRef(-1);
  const wordEls = useRef(new Map());     // "line:kind:i" → span
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const listRef = useRef(null);
  const lineEls = useRef(new Map());
  const synced = lines.some((l) => typeof l.time === "number" && l.time >= 0);

  const registerWords = (line, kind, i, el) => {
    const key = `${line}:${kind}:${i}`;
    if (el) wordEls.current.set(key, el); else wordEls.current.delete(key);
  };

  useEffect(() => {
    idxRef.current = -1;
    setIdx(-1);
    if (!lines.length || !synced) return;
    let raf = 0;
    const paint = (lineIdx, now) => {
      const line = lines[lineIdx];
      if (!line) return;
      const fill = (arr, kind) => arr?.forEach((w, i) => {
        const el = wordEls.current.get(`${lineIdx}:${kind}:${i}`);
        if (el) el.style.setProperty("--p", String(wordProgress(w, now)));
      });
      fill(line.words, "w");
      fill(line.bgWords, "b");
    };
    const loop = () => {
      // Subtracting the offset looks at an earlier point of the song, so lyrics fire later —
      // the same convention as Kodama's own lyrics view (see lyrics/offset.js).
      const now = karaoke.songTime() - offsetRef.current;
      const i = activeLineIndex(lines, now);
      if (i !== idxRef.current) {
        // The line we leave is finished: fill it completely so it does not freeze half-sung.
        const prev = idxRef.current;
        if (prev >= 0) paint(prev, Infinity);
        idxRef.current = i;
        setIdx(i);
      }
      if (i >= 0) paint(i, now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lines, synced]);

  // Full variant: keep the active line in the middle of the scroll box.
  useEffect(() => {
    if (variant !== "full") return;
    const box = listRef.current;
    const el = lineEls.current.get(Math.max(0, idx));
    if (!box || !el) return;
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [idx, variant]);

  const placeholder = (text, busy = false) => (
    <div className={cn("flex items-center gap-2 text-muted", variant === "full" ? "text-[length:var(--t15,15px)] justify-center py-16" : "text-[length:var(--t12,12px)] py-2")}>
      {busy && <span className="kk-spinner" />}
      {text}
    </div>
  );

  if (waiting) return placeholder(t("karaokeWaitingForHost"));
  if (!lyrics || lyrics.status === "loading") return placeholder(t("karaokeLyricsLoading"), true);
  if (!lines.length) return placeholder(t("karaokeNoLyrics"));

  if (!synced) {
    // Plain (unsynced) lyrics: still useful to sing along with, just without timing.
    return (
      <div ref={listRef} className={cn("overflow-y-auto", variant === "full" ? "max-h-[46vh] text-[length:22px] leading-relaxed" : "max-h-[96px] text-[length:13px]")}>
        {lines.map((l, i) => <div key={i} className="kk-line is-active">{l.text || " "}</div>)}
      </div>
    );
  }

  if (variant === "compact") {
    const cur = idx >= 0 ? lines[idx] : null;
    const nextIdx = idx + 1 < lines.length ? idx + 1 : -1;
    return (
      <div className="flex flex-col gap-1 min-h-[64px]" aria-live="off">
        <div className="text-[17px] font-semibold leading-snug min-h-[24px]">
          {cur
            ? <Line key={idx} line={cur} index={idx} state="active" registerWords={registerWords} />
            : <div className="kk-line is-next">♪</div>}
        </div>
        {nextIdx >= 0 && (
          <div className="text-[13px] leading-snug">
            <Line key={nextIdx} line={lines[nextIdx]} index={nextIdx} state="next" registerWords={registerWords} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="relative overflow-y-auto max-h-[46vh] py-[18vh]"
      style={{ scrollbarWidth: "none", maskImage: "linear-gradient(transparent, #000 22%, #000 78%, transparent)" }}
    >
      {lines.map((line, i) => {
        const state = i === idx ? "active" : i < idx ? "past" : i === idx + 1 ? "next" : "future";
        return (
          <Line
            key={i}
            line={line}
            index={i}
            state={state}
            registerWords={registerWords}
            onRef={(el) => { if (el) lineEls.current.set(i, el); else lineEls.current.delete(i); }}
            style={{
              fontSize: 30, fontWeight: 700, lineHeight: 1.3, padding: "8px 0",
              transform: state === "active" ? "scale(1)" : "scale(0.94)",
              transformOrigin: "left center",
            }}
          />
        );
      })}
    </div>
  );
}
