// Live Karaoke Room — "Mic & sound check".
//
// Lets someone confirm, before or during a room, that
//   1. Kodama can open their microphone (and which one), with a live level meter and the
//      exact reason when it can't;
//   2. they can hear themselves: a 3-second recording played back;
//   3. sound from the voice chat reaches their speakers — a test chime, for people without a
//      mic too.
// Playback goes through WebAudio → the default output, the same path friends' voices take, so
// a working test means voices will be audible.

import { useEffect, useRef, useState } from "react";
import { Button, cn } from "@heroui/react";
import { useLang } from "../context.jsx";
import { Microphone, MicrophoneSlash, SpeakerHigh, CheckCircle, WarningCircle } from "../icons.jsx";
import { karaoke } from "./session.js";
import { micConstraints } from "./voice-mesh.js";

const ERROR_KEYS = {
  NotFoundError: "karaokeMicErrNotFound",
  DevicesNotFoundError: "karaokeMicErrNotFound",
  NotAllowedError: "karaokeMicErrDenied",
  SecurityError: "karaokeMicErrDenied",
  PermissionDeniedError: "karaokeMicErrDenied",
  NotReadableError: "karaokeMicErrInUse",
  TrackStartError: "karaokeMicErrInUse",
  AbortError: "karaokeMicErrInUse",
  OverconstrainedError: "karaokeMicErrDevice",
  NotSupportedError: "karaokeMicUnsupported",
};
export const micErrorKey = (name) => ERROR_KEYS[name] || "karaokeMicErrOther";

const HEARD_LEVEL = 0.06;          // meter value that counts as "we can hear you"

function newCtx() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function MicCheck() {
  const t = useLang();
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(() => karaoke.micDeviceId);
  const [status, setStatus] = useState("idle");   // idle | starting | live | error
  const [error, setError] = useState(null);       // { name, message }
  const [heard, setHeard] = useState(false);
  const [busy, setBusy] = useState(null);         // "record" | "chime" | null
  const [played, setPlayed] = useState(null);     // "record" | "chime" | null
  const meterRef = useRef(null);
  const live = useRef({ stream: null, ctx: null, raf: 0 });

  const listDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));
    } catch { setDevices([]); }
  };

  const stop = () => {
    const l = live.current;
    cancelAnimationFrame(l.raf);
    l.stream?.getTracks().forEach((tr) => tr.stop());
    l.ctx?.close().catch(() => {});
    live.current = { stream: null, ctx: null, raf: 0 };
    if (meterRef.current) meterRef.current.style.width = "0%";
  };

  useEffect(() => {
    listDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", listDevices);
      stop();
    };
  }, []);

  const start = async (id = deviceId) => {
    stop();
    setStatus("starting");
    setError(null);
    setHeard(false);
    setPlayed(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("getUserMedia unavailable"), { name: "NotSupportedError" });
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints(karaoke.state.singingMode, id));
      const ctx = newCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const loop = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        if (meterRef.current) meterRef.current.style.width = `${Math.round(lvl * 100)}%`;
        if (lvl > HEARD_LEVEL) setHeard(true);
        live.current.raf = requestAnimationFrame(loop);
      };
      live.current = { stream, ctx, raf: requestAnimationFrame(loop) };
      setStatus("live");
      listDevices();                 // device names only become readable once access is granted
    } catch (e) {
      setStatus("error");
      setError({ name: e?.name || "Error", message: e?.message || String(e) });
    }
  };

  const chooseDevice = (id) => {
    setDeviceId(id);
    karaoke.setMicDevice(id);        // also switches a live room mic over to it
    if (status === "live" || status === "error") start(id);
  };

  /** Record 3 seconds and play them back through the voice-chat output path. */
  const recordAndPlay = async () => {
    const stream = live.current.stream;
    if (!stream || !window.MediaRecorder) return;
    setBusy("record");
    try {
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      const done = new Promise((res) => { rec.onstop = res; });
      rec.start();
      await new Promise((r) => setTimeout(r, 3000));
      rec.stop();
      await done;
      const ctx = newCtx();
      const audio = await ctx.decodeAudioData(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(ctx.destination);
      await new Promise((res) => { src.onended = res; src.start(); });
      ctx.close().catch(() => {});
      setPlayed("record");
    } catch (e) {
      setError({ name: e?.name || "Error", message: e?.message || String(e) });
    }
    setBusy(null);
  };

  /** A short two-note chime through the voice-chat output path (no mic needed). */
  const chime = async () => {
    setBusy("chime");
    try {
      const ctx = newCtx();
      const now = ctx.currentTime + 0.05;
      [[660, 0], [880, 0.22]].forEach(([f, at]) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, now + at);
        g.gain.linearRampToValueAtTime(0.25, now + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, now + at + 0.4);
        osc.connect(g).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.42);
      });
      await new Promise((r) => setTimeout(r, 800));
      const running = ctx.state === "running";
      ctx.close().catch(() => {});
      if (!running) throw Object.assign(new Error("Audio output is paused by the system"), { name: "AudioSuspended" });
      setPlayed("chime");
    } catch (e) {
      setError({ name: e?.name || "Error", message: e?.message || String(e) });
    }
    setBusy(null);
  };

  const label = (d, i) => d.label || `${t("karaokeMicDevice")} ${i + 1}`;

  return (
    <div className="kk-card mt-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="kk-entry-icon" style={{ width: 36, height: 36, borderRadius: 12, fontSize: 15 }}><Microphone size={15} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[length:var(--t14,14px)] font-semibold">{t("karaokeMicCheck")}</div>
          <div className="text-[length:var(--t12)] text-muted">{t("karaokeMicCheckDesc")}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={deviceId}
          onChange={(e) => chooseDevice(e.target.value)}
          aria-label={t("karaokeMicDevice")}
          className="h-9 rounded-[var(--r-full)] px-3 text-[length:var(--t13)] min-w-[220px] max-w-full"
          style={{ background: "var(--field-background, var(--surface-2))", color: "var(--text-primary)", border: "1px solid var(--border)" }}
        >
          <option value="">{t("karaokeMicDefault")}</option>
          {devices.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>
          ))}
        </select>
        {status === "live"
          ? <Button variant="secondary" onPress={() => { stop(); setStatus("idle"); }}>{t("karaokeMicStop")}</Button>
          : <Button variant="secondary" onPress={() => start()}>{status === "starting" ? "…" : t("karaokeMicTest")}</Button>}
        <Button variant="ghost" isDisabled={status !== "live" || !!busy} onPress={recordAndPlay}>
          {busy === "record" ? t("karaokeMicRecording") : t("karaokeMicRecord")}
        </Button>
        <Button variant="ghost" isDisabled={!!busy} onPress={chime}>
          <SpeakerHigh size={13} /> {t("karaokeTestSound")}
        </Button>
      </div>

      {/* level meter */}
      <div className="mt-3 h-2 rounded-full overflow-hidden" style={{ background: "var(--fill-subtle, rgba(255,255,255,.08))" }}>
        <div ref={meterRef} className="h-full rounded-full" style={{ width: "0%", background: "var(--accent)", transition: "width 60ms linear" }} />
      </div>

      <div className="mt-2.5 flex flex-col gap-1.5 text-[length:var(--t12)]">
        {status === "idle" && !error && <span className="text-muted">{t("karaokeMicIdle")}</span>}
        {status === "live" && (
          <span className={cn("flex items-center gap-1.5", heard ? "text-[color:var(--status-success)]" : "text-secondary")}>
            {heard ? <CheckCircle size={12} weight="fill" /> : <Microphone size={12} />}
            {heard ? t("karaokeMicHeard") : t("karaokeMicSpeak")}
          </span>
        )}
        {played === "record" && <span className="text-secondary">{t("karaokeMicPlayedBack")}</span>}
        {played === "chime" && <span className="text-secondary">{t("karaokeTestSoundPlayed")}</span>}
        {error && (
          <span className="flex items-start gap-1.5" style={{ color: "var(--status-warning)" }}>
            {error.name === "AudioSuspended" ? <WarningCircle size={12} className="mt-0.5 shrink-0" /> : <MicrophoneSlash size={12} className="mt-0.5 shrink-0" />}
            <span>
              {t(error.name === "AudioSuspended" ? "karaokeAudioSuspended" : micErrorKey(error.name))}
              <span className="text-muted"> ({error.name}{error.message ? `: ${error.message}` : ""})</span>
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
