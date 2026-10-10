# Live Karaoke Room

Sing together with up to **5 people** (host + 4 guests). The host plays songs in Kodama as usual;
everyone in the room hears the same song in sync on their own Kodama, sees the **word-synced
lyrics**, and talks/sings over **live microphones** (WebRTC). There is no text chat.

## Using it

* Sidebar → **Karaoke Room** → **Create a room**. You get a 6-character Room ID (e.g. `U4ED2T`)
  and an invite like `U4ED2T@192.168.1.20` — share that.
* Friends: **Karaoke Room → Join by ID**, paste the invite (or type the ID + your address).
* Play any song. Guests' players follow the host (track, play/pause, seeks) automatically.
* While in a room, a compact overlay floats on every page: the 5 seats with live mic levels and
  mute states, your mic toggle, the current + next lyric line. Click a seat for that person's
  controls (mute for me, volume 0–200 %, and — host — remove). Drag it by its header, collapse it
  to a pill, or open the full room page.
* **Wear headphones.** Echo cancellation can't remove music that comes from Kodama's native audio
  engine, so speakers would send the backing track back to everyone.
* **Singing mode** turns off noise suppression / auto-gain, which otherwise chop held notes.

## Networking

| Situation | What to do |
|---|---|
| Same Wi-Fi / LAN | Nothing. The host's kodama-server already listens on `0.0.0.0:9847`. Allow Kodama through the OS firewall when asked. |
| Different networks | Use a VPN mesh (Tailscale, ZeroTier) and share the host's VPN IP, **or** forward TCP 9847 on the host's router, **or** run a relay (below). |
| Strict NAT (voices never connect) | Add a TURN server under *Advanced* in the Create/Join modal (`turn:host:3478\|user\|password`). |

**Relay server** (for groups that aren't on one network):

```bash
pip install flask flask-cors requests
python python-backend/karaoke_room.py --host 0.0.0.0 --port 9847 --relay --max-rooms 50
```

Put it behind TLS (e.g. Caddy/nginx → `https://karaoke.example.com:9847`; disable proxy buffering
for `/events`). In *Create a room* pick **Relay server** and enter its address; guests join with
`CODE@https://karaoke.example.com:9847`.

## How it works

```
 Host Kodama                         Guest Kodama (×4)
 ┌──────────────────────┐            ┌──────────────────────┐
 │ webview              │  WebRTC    │ webview              │
 │  VoiceMesh ◄─────────┼── Opus ───►│  VoiceMesh           │   full mesh, ≤4 peers each
 │  HostPublisher       │            │  GuestFollower ──► local player (same videoId,
 │   │ playback+lyrics  │            │   ▲ seeks/pauses to stay ≤0.25 s off the host)
 │   ▼                  │            │   │ SSE                │
 │ kodama-server :9847  │◄── HTTP ───┼─ kodama-server :9847 /karaoke/via (local proxy)
 │  /karaoke/* rooms    │            └──────────────────────┘
 └──────────────────────┘
```

* **Room server** — `python-backend/karaoke_room.py`, a Flask blueprint registered on the existing
  kodama-server. Rooms, 6-char codes, the **hard 5-person cap (enforced under a lock)**, one
  Server-Sent-Events stream per participant, and small JSON POSTs for WebRTC signaling, playback
  state, lyrics and mic state. Rooms can only be created from the host's own machine; joins are
  rate-limited per IP.
* **Guests reach the host through their own kodama-server** (`/karaoke/via`): the app's pages are
  on a secure origin, so WebKit (macOS/Linux) blocks plain `http://<lan-ip>`; localhost is exempt,
  and the app CSP stays `localhost:9847`-only.
* **Music isn't streamed.** Kodama's audio is native (Rust/rodio), so each guest plays the song on
  their own player. The host publishes `{track, position, isPlaying, at}` where `at` is on the
  room server's clock (NTP-style offset probe); guests extrapolate and correct with seeks whose
  lead adapts to how long a seek takes on that machine.
* **Lyrics** — the host sends the parsed, word/syllable-level lines once per song (TTML /
  Musixmatch richsync / LRC from Kodama's normal providers, honouring the host's per-song lyric
  offset). Every client renders them against its own synced playhead, filling each word as it's
  sung.
* **Voice** — WebRTC full mesh, mono Opus at 64 kbps with FEC, minimal jitter buffer; per-person
  gain/mute through WebAudio; live level meters. Pairs that don't connect within 10 s are rebuilt
  automatically.
* **Native (Rust)** — `src-tauri/src/karaoke.rs`: grants the webview microphone permission
  (WebView2 `PermissionRequested`, WebKitGTK media-stream/WebRTC settings + permission request);
  on Windows, opts Kodama's playback out of "communications ducking" while the mic is live.
  macOS uses `Info.plist` (`NSMicrophoneUsageDescription`) and `Entitlements.plist`.

## Files

| Area | File |
|---|---|
| Python | `python-backend/karaoke_room.py` (new), `server.py` (registers blueprint), `*.spec` (hidden import), `tests/test_karaoke_room.py` |
| Rust / Tauri | `src-tauri/src/karaoke.rs` (new), `src/main.rs`, `Cargo.toml`, `Info.plist`, `Entitlements.plist`, `tauri.macos.conf.json` |
| React | `src/karaoke/*` (new), `src/App.jsx` (sidebar entry, view, root mount), `src/icons.jsx`, `src/locales/en.json`, `de.json` |
| Tests | `e2e/karaoke/` — 6 Chromium windows, real WebRTC + room server, fake player |

## Tests

```bash
python -m pytest python-backend/tests -q                         # room server
python python-backend/karaoke_room.py --port 9847 --proxy &      # e2e: room server
npx vite &                                                       # e2e: frontend
python e2e/karaoke/run_e2e.py                              # e2e: 59 checks
```

## Limits / known caveats

* Everyone needs Kodama and access to the song (region locks, premium-only tracks).
* Voices arrive with network latency (typically 20–150 ms on a LAN/VPN, more across the
  internet) — singing *together* works best on a LAN or a nearby VPN peer.
* Linux: voice needs a WebKitGTK built with WebRTC (GStreamer `webrtcbin`). Without it you can
  still join, follow playback and see lyrics; the mic shows as unsupported.
