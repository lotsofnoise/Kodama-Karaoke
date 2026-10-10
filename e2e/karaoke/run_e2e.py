"""
End-to-end test for the Live Karaoke Room: six real Chromium windows, real WebRTC, the real
room server and the real karaoke modules/UI — only the native audio player is faked
(e2e/karaoke/harness.jsx), with simulated clock drift and seek latency per window.

    # 1. room server, also serving /karaoke/via like kodama-server does for its own window
    python python-backend/karaoke_room.py --port 9847 --proxy
    # 2. the frontend dev server
    npx vite
    # 3. this script  (pip install playwright && playwright install chromium)
    python e2e/karaoke/run_e2e.py

Screenshots land in e2e/karaoke/out/.
"""
import asyncio, json, math, os, struct, sys, tempfile, wave
from playwright.async_api import async_playwright

URL = os.environ.get("KARAOKE_E2E_URL", "http://localhost:1421/e2e/karaoke/index.html")
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(SHOTS, exist_ok=True)

# Continuous 440 Hz tone as everyone's "microphone" (Chromium's default fake mic only beeps).
TONE = os.path.join(tempfile.gettempdir(), "kodama-karaoke-tone.wav")
with wave.open(TONE, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
    w.writeframes(b"".join(struct.pack("<h", int(9000 * math.sin(2 * math.pi * 440 * i / 48000))) for i in range(48000 * 3)))
TRACK = {"videoId": "dQw4w9WgXcQ", "title": "Test Song", "artists": "Test Artist", "album": "", "thumbnail": "", "duration": "4:00"}
LRC = {"source": "Test", "lrc": [
  {"time": 0.5, "endTime": 3.0, "wordSync": True, "words": [{"text": "Never ", "time": 0.5, "end": 1.0}, {"text": "gonna ", "time": 1.0, "end": 1.5}, {"text": "give ", "time": 1.5, "end": 2.0}, {"text": "you ", "time": 2.0, "end": 2.4}, {"text": "up", "time": 2.4, "end": 3.0}]},
  {"time": 3.0, "endTime": 6.0, "wordSync": True, "words": [{"text": "Never ", "time": 3.0, "end": 3.5}, {"text": "gonna ", "time": 3.5, "end": 4.0}, {"text": "let ", "time": 4.0, "end": 4.5}, {"text": "you ", "time": 4.5, "end": 5.0}, {"text": "down", "time": 5.0, "end": 6.0}]},
] + [{"time": 6.0 + i * 3, "endTime": 9.0 + i * 3, "text": f"line {i}"} for i in range(60)]}

failures = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg); 
    if not cond: failures.append(msg)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={TONE}",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-features=WebRtcHideLocalIpsWithMdns"])
        pages = []
        async def new_page(rate="1", view="karaoke"):
            ctx = await browser.new_context(viewport={"width": 1280, "height": 860}, permissions=["microphone"])
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: print("PAGEERROR", e))
            pg.on("console", lambda m: m.type == "error" and print("CONSOLE", m.text))
            await pg.goto(f"{URL}?rate={rate}&view={view}")
            await pg.wait_for_function("window.__h")
            pages.append(pg)
            return pg

        host = await new_page()
        await host.evaluate("([k, v]) => localStorage.setItem(k, v)", ["kiyoshi-lyrics-" + TRACK["videoId"], json.dumps(LRC)])
        await host.screenshot(path=f"{SHOTS}/01-lobby.png")
        # Create via the UI
        await host.get_by_role("button", name="Create a room").first.click()
        await host.get_by_label("Your name").fill("Sadie")
        await host.screenshot(path=f"{SHOTS}/02-create-modal.png")
        await host.get_by_role("button", name="Create room").last.click()
        await host.wait_for_function("window.__h.karaoke.state.phase === 'in-room'", timeout=8000)
        code = await host.evaluate("window.__h.karaoke.state.roomId")
        check(len(code) == 6, f"room created with code {code}")

        async def join(name, rate):
            g = await new_page(rate)
            await g.get_by_role("button", name="Join by ID").first.click()
            await g.get_by_label("Room ID").fill(f"{code.lower()}@127.0.0.1")
            await g.get_by_label("Your name").fill(name)
            return g

        guests = []
        for i, (name, rate) in enumerate([("Ana", "1.004"), ("Ben", "0.996"), ("Chi", "1"), ("Dev", "1.01")]):
            g = await join(name, rate)
            if i == 0:
                await g.screenshot(path=f"{SHOTS}/03-join-modal.png")
            await g.get_by_role("button", name="Join room").last.click()
            await g.wait_for_function("window.__h.karaoke.state.phase === 'in-room'", timeout=8000)
            guests.append(g)
        n = await host.evaluate("window.__h.karaoke.state.participants.length")
        check(n == 5, f"5 participants in room (got {n})")

        # 6th person: must be refused with the room-full message
        sixth = await join("Eve", "1")
        await sixth.get_by_role("button", name="Join room").last.click()
        await sixth.wait_for_selector("text=That room is full", timeout=6000)
        check(True, "6th join refused with 'room full' message")
        st = await sixth.evaluate("window.__h.karaoke.state.phase")
        check(st == "idle", "6th participant stays out of the room")
        await sixth.screenshot(path=f"{SHOTS}/04-room-full.png")
        await sixth.context.close(); pages.remove(sixth)

        # WebRTC mesh: every participant connected to the 4 others
        everyone = [host] + guests
        await asyncio.sleep(6)
        for i, pg in enumerate(everyone):
            states = await pg.evaluate("Object.values(window.__h.karaoke.state.peerStates)")
            conn = sum(1 for s in states if s == "connected")
            check(conn == 4, f"participant {i} has 4/4 peer connections connected ({states})")
        for i, pg in enumerate(everyone):
            mx = {}
            for _ in range(15):
                lv = await pg.evaluate("window.__h.karaoke.getLevels()")
                for k, v in lv.items(): mx[k] = max(mx.get(k, 0), v)
                await asyncio.sleep(0.1)
            self_id = await pg.evaluate("window.__h.karaoke.state.selfId")
            remote = [v for k, v in mx.items() if k != self_id]
            check(len(remote) == 4 and all(v > 0.01 for v in remote), f"participant {i} hears all 4 others {[round(v,3) for v in remote]}")
            mic = await pg.evaluate("window.__h.karaoke.state.micState")
            check(mic == "live", f"participant {i} mic live")

        # Host plays a song → guests load it and sync
        await host.evaluate(f"window.__h.play({json.dumps(TRACK)})")
        await asyncio.sleep(7)
        hp = await host.evaluate("window.__h.audio.currentTime")
        for i, g in enumerate(guests):
            vid = await g.evaluate("window.__h.karaoke.state.playback?.track?.videoId")
            check(vid == TRACK["videoId"], f"guest {i} got track")
            # compare at the same instant via server clock
            res = await asyncio.gather(host.evaluate("[window.__h.audio.currentTime, window.__h.karaoke.client.serverNow()]"),
                                       g.evaluate("[window.__h.audio.currentTime, window.__h.karaoke.client.serverNow()]"))
            (h_ct, h_now), (g_ct, g_now) = res
            drift = (g_ct - (h_ct + (g_now - h_now) / 1000))
            check(abs(drift) < 0.3, f"guest {i} within 0.3s of host (drift {drift:+.3f}s)")
            lyr = await g.evaluate("window.__h.karaoke.state.lyrics")
            check(lyr and lyr["status"] == "ok" and len(lyr["lines"]) == 62 and lyr["lines"][0]["words"][2]["text"] == "give ", f"guest {i} received word-synced lyrics")
        await asyncio.sleep(10)
        for i, g in enumerate(guests):
            res = await asyncio.gather(host.evaluate("[window.__h.audio.currentTime, window.__h.karaoke.client.serverNow()]"),
                                       g.evaluate("[window.__h.audio.currentTime, window.__h.karaoke.client.serverNow(), window.__h.audio.seeks]"))
            (h_ct, h_now), (g_ct, g_now, seeks) = res
            drift = (g_ct - (h_ct + (g_now - h_now) / 1000))
            lead = await g.evaluate("window.__h.karaoke.follower.seekLead")
            check(abs(drift) < 0.3, f"guest {i} still in sync after 10s with clock drift (drift {drift:+.3f}s, {seeks} seeks, lead {lead:.3f}s)")

        # Host pauses → guests pause; host seeks → guests follow
        await host.evaluate("window.__h.audio.pause()")
        await asyncio.sleep(2)
        for i, g in enumerate(guests):
            check(await g.evaluate("window.__h.audio.paused"), f"guest {i} paused with host")
        await host.evaluate("window.__h.audio.currentTime = 2.2; window.__h.audio.play()")
        await asyncio.sleep(1.4)
        await host.screenshot(path=f"{SHOTS}/05-room-host.png")
        await asyncio.sleep(2.5)
        for i, g in enumerate(guests):
            res = await asyncio.gather(host.evaluate("[window.__h.audio.currentTime, window.__h.karaoke.client.serverNow()]"),
                                       g.evaluate("[window.__h.audio.currentTime, window.__h.karaoke.client.serverNow(), window.__h.audio.paused]"))
            (h_ct, h_now), (g_ct, g_now, paused) = res
            drift = (g_ct - (h_ct + (g_now - h_now) / 1000))
            check(not paused and abs(drift) < 0.3, f"guest {i} followed seek+resume (drift {drift:+.3f}s)")

        # Lyrics on screen: active line on the guest page matches the host page
        await host.evaluate("window.__h.audio.currentTime = 3.6")
        await asyncio.sleep(2.0)
        h_line = await host.evaluate("document.querySelector('.kk-line.is-active')?.textContent")
        g_line = await guests[0].evaluate("document.querySelector('.kk-line.is-active')?.textContent")
        check(h_line == g_line == "Never gonna let you down", f"same active lyric line on host and guest ({h_line!r} / {g_line!r})")
        p = await guests[0].evaluate("[...document.querySelectorAll('.kk-line.is-active .kk-word')].map(e => e.style.getPropertyValue('--p'))")
        check(len(p) == 5 and float(p[0]) == 1.0, f"word-level fill progressing {p}")
        await guests[0].screenshot(path=f"{SHOTS}/06-room-guest.png")

        # Mic mute propagates; per-person volume
        await guests[1].evaluate("window.__h.karaoke.toggleMic()")
        await asyncio.sleep(1.0)
        ben_id = await guests[1].evaluate("window.__h.karaoke.state.selfId")
        muted = await host.evaluate(f"window.__h.karaoke.state.participants.find(p => p.id === '{ben_id}').muted")
        check(muted, "guest mic mute visible to host")
        lv = await host.evaluate(f"window.__h.karaoke.getLevels()['{ben_id}']")
        check(lv < 0.01, f"muted guest is silent at host (level {lv:.4f})")
        ana_id = await guests[0].evaluate("window.__h.karaoke.state.selfId")
        await host.evaluate(f"window.__h.karaoke.togglePeerMuted('{ana_id}')")
        await asyncio.sleep(0.6)
        lv = await host.evaluate(f"window.__h.karaoke.getLevels()['{ana_id}']")
        check(lv < 0.01, f"host locally muted Ana (level {lv:.4f})")
        await host.evaluate(f"window.__h.karaoke.togglePeerMuted('{ana_id}'); window.__h.karaoke.setPeerVolume('{ana_id}', 1.5)")

        # Overlay on another page
        await guests[0].evaluate("window.__h.setView('home')")
        await asyncio.sleep(0.8)
        check(await guests[0].locator(".kk-overlay").count() == 1, "compact overlay visible on other pages")
        slots = await guests[0].locator(".kk-overlay .kk-slot-btn").count()
        check(slots == 5, f"overlay shows 5 slots (got {slots})")
        await guests[0].locator(".kk-overlay .kk-slot-btn").nth(0).click()
        await asyncio.sleep(0.4)
        await guests[0].screenshot(path=f"{SHOTS}/07-overlay.png")

        # Kick, then host closes the room
        dev_id = await guests[3].evaluate("window.__h.karaoke.state.selfId")
        await host.evaluate(f"window.__h.karaoke.kick('{dev_id}')")
        await asyncio.sleep(1.5)
        check(await guests[3].evaluate("window.__h.karaoke.state.endReason") == "kicked", "kicked guest is out")
        n = await host.evaluate("window.__h.karaoke.state.participants.length")
        check(n == 4, f"room has 4 after kick (got {n})")
        # freed seat can be taken again
        late = await join("Fay", "1")
        await late.get_by_role("button", name="Join room").last.click()
        await late.wait_for_function("window.__h.karaoke.state.phase === 'in-room'", timeout=8000)
        check(True, "freed seat re-joinable")
        await host.evaluate("window.__h.karaoke.leave()")
        await asyncio.sleep(1.5)
        for i, g in enumerate(guests[:3] + [late]):
            r = await g.evaluate("window.__h.karaoke.state.endReason")
            check(r in ("host_left", "closed"), f"guest {i} told room closed ({r})")
        await guests[0].screenshot(path=f"{SHOTS}/08-closed.png")
        await browser.close()
    print("\nFAILURES:", len(failures))
    for f in failures: print(" -", f)
    return 1 if failures else 0


async def mic_denied():
    """Someone who refuses the microphone still joins, follows playback and sees lyrics."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--use-fake-device-for-media-stream"])
        host_ctx = await browser.new_context(permissions=["microphone"])
        guest_ctx = await browser.new_context()
        host, guest = await host_ctx.new_page(), await guest_ctx.new_page()
        # The person clicks "Block" on the permission prompt.
        await guest.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));")
        for pg in (host, guest):
            await pg.goto(URL); await pg.wait_for_function("window.__h")
        await host.evaluate("window.__h.karaoke.createRoom({name: 'Host'})")
        code = await host.evaluate("window.__h.karaoke.state.roomId")
        await guest.evaluate(f"window.__h.karaoke.joinRoom({{code: '{code}', server: '127.0.0.1', name: 'Quiet'}})")
        await host.evaluate(f"window.__h.play({json.dumps(TRACK)})")
        await asyncio.sleep(4)
        st = await guest.evaluate("window.__h.karaoke.state")
        check(st["phase"] == "in-room" and st["micState"] == "blocked" and st["micMuted"], f"mic refused → still in room, mic blocked+muted ({st['micState']})")
        check(st["playback"]["track"]["videoId"] == TRACK["videoId"], "mic-less guest still follows playback")
        await guest.screenshot(path=f"{SHOTS}/09-mic-blocked.png")
        await host.evaluate("window.__h.karaoke.leave()")
        await browser.close()


async def all_tests():
    await main()
    await mic_denied()
    print("\nTOTAL FAILURES:", len(failures))
    return 1 if failures else 0

sys.exit(asyncio.run(all_tests()))
