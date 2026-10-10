// Test harness: the real karaoke modules + UI, with a fake player behind the player bridge.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "../../src/index.css";
import { applyTheme } from "../../src/theme.js";
import { LangContext } from "../../src/context.jsx";
import { registerAudio, registerPlayerAction, registerPlayHandler, setNowPlaying, getNowPlaying } from "../../src/now-playing.js";
import { KaraokeView } from "../../src/karaoke/KaraokeView.jsx";
import { KaraokeRoot } from "../../src/karaoke/KaraokeRoot.jsx";
import { karaoke } from "../../src/karaoke/session.js";

const params = new URLSearchParams(location.search);
const RATE = parseFloat(params.get("rate") || "1");          // simulated clock drift
const SEEK_MS = parseInt(params.get("seekms") || "120", 10);   // simulated seek latency

class FakeAudio {
  constructor() { this._ct = 0; this._t0 = performance.now(); this.paused = true; this.duration = 0; this.isPreparing = false; this.l = {}; this.seeks = 0;
    setInterval(() => this._fire("timeupdate"), 250); }
  get currentTime() { return this.paused ? this._ct : this._ct + ((performance.now() - this._t0) / 1000) * RATE; }
  set currentTime(v) { this.seeks++; setTimeout(() => { this._ct = v; this._t0 = performance.now(); this._fire("seeked"); }, SEEK_MS); }
  play() { this._ct = this.currentTime; this._t0 = performance.now(); this.paused = false; this._fire("play"); }
  pause() { this._ct = this.currentTime; this.paused = true; this._fire("pause"); }
  load(track) { this.isPreparing = true; this.paused = true; this._ct = 0; this.duration = 0;
    setTimeout(() => { this.isPreparing = false; this.duration = 240; this.play(); }, 400); }
  addEventListener(t, f) { (this.l[t] ||= new Set()).add(f); }
  removeEventListener(t, f) { this.l[t]?.delete(f); }
  _fire(t) { this.l[t]?.forEach((f) => f()); }
}
const audio = new FakeAudio();
registerAudio(audio);
const play = (track) => { setNowPlaying({ ...getNowPlaying(), track, hasTrack: true, title: track.title }); audio.load(track); };
registerPlayHandler((track) => play(track));
registerPlayerAction((cmd) => {
  const a = cmd?.action || cmd;
  if (a === "playpause") (audio.paused ? audio.play() : audio.pause());
  else if (a === "seek" && typeof cmd.position === "number") audio.currentTime = cmd.position;
});

const toasts = [];
window.__h = { karaoke, audio, play, toasts };

function Harness() {
  const [view, setView] = useState(params.get("view") || "karaoke");
  window.__h.setView = setView;
  const addToast = (m, type) => { toasts.push({ m, type }); console.log("[toast]", type, m); };
  return (
    <LangContext.Provider value="en">
      <div style={{ display: "flex", height: "100vh", color: "var(--text-primary)" }}>
        <div style={{ width: 180, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <button onClick={() => setView("home")}>Home</button>
          <button onClick={() => setView("karaoke")}>Karaoke Room</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", background: "var(--bg-surface)", borderRadius: 16, margin: 8 }}>
          {view === "karaoke" ? <KaraokeView addToast={addToast} /> : <div style={{ padding: 32, fontSize: 24 }}>Home (some other page)</div>}
        </div>
      </div>
      <KaraokeRoot view={view} addToast={addToast} onOpenRoom={() => setView("karaoke")} />
    </LangContext.Provider>
  );
}
applyTheme("dark");
ReactDOM.createRoot(document.getElementById("root")).render(<Harness />);
