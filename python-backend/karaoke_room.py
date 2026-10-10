"""
Kodama — Live Karaoke Room server.

A small, dependency-free (Flask only) room server for up to five people:

* Rooms are addressed by a 6-character code (no 0/O/1/I so it can be read out loud).
* A room holds at most MAX_PARTICIPANTS people, host included. The cap is enforced here, under
  a lock, so two people racing for the last slot can never both get in.
* Each participant holds one Server-Sent-Events stream (GET .../events) and talks back with
  small JSON POSTs. That is all the transport the feature needs:
    - WebRTC signaling (SDP offers/answers + ICE candidates) is relayed peer-to-peer through
      POST .../signal. Voice itself never touches this server; it flows directly between the
      participants' webviews (full mesh, at most 4 peer connections each).
    - The host publishes the playback state (track, position, playing) and the word-level
      lyrics of the current song; the server stamps playback with its own clock and fans it
      out. Late joiners get the latest state in the snapshot that opens their stream.
* No text chat, by design — there is no endpoint that carries free text between people other
  than display names.

Two ways to run it:

1. Embedded in kodama-server (the default). server.py registers the blueprint on the main
   Flask app, which already listens on 0.0.0.0:9847. Rooms can then only be CREATED from the
   local machine (the Kodama window); friends on the same network — or over a forwarded port /
   VPN such as Tailscale — join with the code plus the host's address.

2. Stand-alone relay for groups that are not on one network:
       python karaoke_room.py --host 0.0.0.0 --port 9847 --relay
   Anyone who can reach it may create a room (capped by --max-rooms). Put it behind TLS if it
   faces the internet. Kodama's "Relay server" field then points at it.
"""
from __future__ import annotations

import hmac
import json
import queue
import secrets
import threading
import time
from collections import deque

from flask import Blueprint, Response, jsonify, request, stream_with_context

MAX_PARTICIPANTS = 5                     # host + 4 guests — hard cap, see _join()
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_CODE_LEN = 6
NAME_MAX = 32

KEEPALIVE_S = 15                         # SSE comment so dead sockets surface on write
STALE_AFTER_S = 25                       # no open stream for this long → participant dropped
JOIN_GRACE_S = 20                        # time a fresh joiner gets to open its stream
EMPTY_ROOM_TTL_S = 60                    # safety net for rooms whose host vanished silently

QUEUE_MAX = 1000                         # per-participant event backlog
MAX_SIGNAL_BYTES = 64 * 1024             # one SDP or ICE message
MAX_LYRICS_BYTES = 1024 * 1024           # word-synced TTML for a long song is ~100–300 KB
MAX_PLAYBACK_BYTES = 8 * 1024
PLAYBACK_MIN_INTERVAL_S = 0.05           # host may publish at most ~20 updates/s

RATE_WINDOW_S = 60                       # join/lookup attempts per IP per window
RATE_MAX = 30

VERSION = 1


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_name(raw, fallback: str) -> str:
    name = " ".join(str(raw or "").split())[:NAME_MAX]
    # Strip control characters; names are the only user text that travels through a room.
    name = "".join(ch for ch in name if ch.isprintable())
    return name or fallback


class Participant:
    __slots__ = ("id", "token", "name", "slot", "is_host", "muted", "joined_at",
                 "last_seen", "streams", "queue", "remote_addr")

    def __init__(self, name: str, slot: int, is_host: bool, remote_addr: str):
        self.id = secrets.token_hex(6)
        self.token = secrets.token_urlsafe(18)
        self.name = name
        self.slot = slot
        self.is_host = is_host
        self.muted = False
        self.joined_at = time.time()
        self.last_seen = time.time()
        self.streams = 0
        self.queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        self.remote_addr = remote_addr

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "slot": self.slot,
                "isHost": self.is_host, "muted": self.muted,
                "connected": self.streams > 0}


class Room:
    def __init__(self, code: str):
        self.code = code
        self.created_at = time.time()
        self.participants: dict[str, Participant] = {}
        self.host_id: str | None = None
        self.playback: dict | None = None
        self.lyrics: dict | None = None
        self.last_playback_at = 0.0
        self.closed = False

    def free_slot(self) -> int | None:
        used = {p.slot for p in self.participants.values()}
        for s in range(MAX_PARTICIPANTS):
            if s not in used:
                return s
        return None

    def roster(self) -> list[dict]:
        return sorted((p.public() for p in self.participants.values()), key=lambda d: d["slot"])


class KaraokeRegistry:
    """All rooms of one server process. Every mutation happens under self.lock."""

    def __init__(self, max_rooms: int):
        self.max_rooms = max_rooms
        self.rooms: dict[str, Room] = {}
        self.lock = threading.RLock()
        self._rate: dict[str, deque] = {}
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True, name="karaoke-reaper")
        self._reaper.start()

    # ── helpers ────────────────────────────────────────────────────────────────
    def _new_code(self) -> str:
        for _ in range(1000):
            code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LEN))
            if code not in self.rooms:
                return code
        raise RuntimeError("no free room code")

    def rate_ok(self, ip: str) -> bool:
        now = time.time()
        with self.lock:
            dq = self._rate.setdefault(ip, deque())
            while dq and now - dq[0] > RATE_WINDOW_S:
                dq.popleft()
            if len(dq) >= RATE_MAX:
                return False
            dq.append(now)
            return True

    def emit(self, room: Room, etype: str, data: dict, only: str | None = None,
             exclude: str | None = None) -> None:
        payload = {"type": etype, "data": data}
        for p in list(room.participants.values()):
            if only and p.id != only:
                continue
            if exclude and p.id == exclude:
                continue
            try:
                p.queue.put_nowait(payload)
            except queue.Full:
                # A consumer that stopped reading. Its stream is dead in all but name; the
                # reaper removes it once the socket finally errors out.
                pass

    def _broadcast_roster(self, room: Room) -> None:
        self.emit(room, "participants", {"participants": room.roster()})

    # ── lifecycle ──────────────────────────────────────────────────────────────
    def create(self, host_name: str, remote_addr: str, replace_existing_local: bool) -> tuple[Room, Participant]:
        with self.lock:
            if replace_existing_local:
                # The embedded server serves one desktop user; a second "create" means they
                # left the old room without the leave call reaching us (crash, reload).
                for r in list(self.rooms.values()):
                    self.close(r, "replaced")
            if len(self.rooms) >= self.max_rooms:
                raise OverflowError("server_full")
            room = Room(self._new_code())
            host = Participant(_clean_name(host_name, "Host"), 0, True, remote_addr)
            room.participants[host.id] = host
            room.host_id = host.id
            self.rooms[room.code] = room
            return room, host

    def join(self, code: str, name: str, remote_addr: str) -> tuple[Room, Participant]:
        with self.lock:
            room = self.rooms.get(code)
            if not room or room.closed:
                raise KeyError("room_not_found")
            # THE hard cap. Checked and filled inside the same critical section.
            if len(room.participants) >= MAX_PARTICIPANTS:
                raise OverflowError("room_full")
            slot = room.free_slot()
            if slot is None:
                raise OverflowError("room_full")
            p = Participant(_clean_name(name, f"Singer {slot + 1}"), slot, False, remote_addr)
            room.participants[p.id] = p
            self._broadcast_roster(room)
            return room, p

    def remove(self, room: Room, pid: str, reason: str = "left") -> None:
        with self.lock:
            p = room.participants.pop(pid, None)
            if not p:
                return
            try:
                p.queue.put_nowait({"type": "kicked" if reason == "kicked" else "bye",
                                    "data": {"reason": reason}})
                p.queue.put_nowait(None)
            except queue.Full:
                pass
            if p.is_host:
                self.close(room, "host_left")
                return
            self.emit(room, "peer-left", {"id": pid})
            self._broadcast_roster(room)

    def close(self, room: Room, reason: str) -> None:
        with self.lock:
            if room.closed:
                return
            room.closed = True
            self.emit(room, "closed", {"reason": reason})
            for p in room.participants.values():
                try:
                    p.queue.put_nowait(None)
                except queue.Full:
                    pass
            room.participants.clear()
            self.rooms.pop(room.code, None)

    def auth(self, code: str, pid: str, token: str) -> tuple[Room, Participant]:
        with self.lock:
            room = self.rooms.get(code)
            if not room or room.closed:
                raise KeyError("room_not_found")
            p = room.participants.get(pid or "")
            if not p or not hmac.compare_digest(p.token, str(token or "")):
                raise PermissionError("forbidden")
            p.last_seen = time.time()
            return room, p

    def snapshot(self, room: Room, me: Participant) -> dict:
        return {
            "roomId": room.code,
            "self": me.public(),
            "participants": room.roster(),
            "maxParticipants": MAX_PARTICIPANTS,
            "playback": room.playback,
            "lyrics": room.lyrics,
            "serverNow": _now_ms(),
        }

    def _reap_loop(self) -> None:
        while True:
            time.sleep(5)
            now = time.time()
            with self.lock:
                for room in list(self.rooms.values()):
                    for p in list(room.participants.values()):
                        if p.streams > 0:
                            continue
                        idle = now - p.last_seen
                        fresh = now - p.joined_at < JOIN_GRACE_S
                        if not fresh and idle > STALE_AFTER_S:
                            self.remove(room, p.id, "timeout")
                    if not room.closed and not room.participants and now - room.created_at > EMPTY_ROOM_TTL_S:
                        self.close(room, "empty")


def create_blueprint(is_local=lambda: True, allow_remote_create: bool = False,
                     max_rooms: int = 1, lan_ips=lambda: [], port: int = 9847,
                     relay: bool = False, enable_proxy: bool = False) -> Blueprint:
    """Build the /karaoke blueprint.

    enable_proxy        — embedded mode: expose /karaoke/via, through which the local Kodama
                          window reaches a room on ANOTHER machine (see _proxy below).

    is_local            — callable: is the current request from this machine?
    allow_remote_create — relay mode: anyone may create rooms (else only localhost).
    max_rooms           — concurrent rooms on this server.
    lan_ips / port      — what the host should tell friends to connect to.
    """
    reg = KaraokeRegistry(max_rooms=max_rooms)
    bp = Blueprint("karaoke", __name__, url_prefix="/karaoke")

    def err(code: str, status: int):
        return jsonify({"ok": False, "error": code}), status

    def body(limit: int) -> dict | None:
        cl = request.content_length
        if cl is not None and cl > limit:
            return None
        # force=True: navigator.sendBeacon (used for "leave" when the window closes) posts
        # its JSON as text/plain.
        data = request.get_json(silent=True, force=True)
        return data if isinstance(data, dict) else {}

    def client_ip() -> str:
        return request.remote_addr or "?"

    def with_member(code: str, data: dict):
        return reg.auth(code.upper(), data.get("pid"), data.get("token"))

    # ── public, read-only ──────────────────────────────────────────────────────
    @bp.route("/time")
    def k_time():
        # Clock-offset probe. Clients do a handful of these and keep the lowest-RTT sample.
        return jsonify({"now": _now_ms()})

    @bp.route("/info")
    def k_info():
        out = {"ok": True, "version": VERSION, "maxParticipants": MAX_PARTICIPANTS,
               "relay": relay, "port": port}
        if is_local():
            out["ips"] = list(lan_ips() or [])
        return jsonify(out)

    @bp.route("/rooms", methods=["POST"])
    def k_create():
        if not allow_remote_create and not is_local():
            return err("forbidden", 403)
        data = body(4096)
        if data is None:
            return err("too_large", 413)
        try:
            room, host = reg.create(data.get("name"), client_ip(),
                                    replace_existing_local=not allow_remote_create)
        except OverflowError:
            return err("server_full", 503)
        return jsonify({
            "ok": True, "roomId": room.code, "participantId": host.id, "token": host.token,
            "slot": host.slot, "isHost": True, "maxParticipants": MAX_PARTICIPANTS,
            "lan": {"ips": list(lan_ips() or []), "port": port}, "relay": relay,
        })

    @bp.route("/rooms/<code>")
    def k_lookup(code):
        if not reg.rate_ok(client_ip()):
            return err("rate_limited", 429)
        with reg.lock:
            room = reg.rooms.get(code.upper())
            if not room:
                return err("room_not_found", 404)
            n = len(room.participants)
            return jsonify({"ok": True, "roomId": room.code, "count": n,
                            "maxParticipants": MAX_PARTICIPANTS, "full": n >= MAX_PARTICIPANTS})

    @bp.route("/rooms/<code>/join", methods=["POST"])
    def k_join(code):
        if not reg.rate_ok(client_ip()):
            return err("rate_limited", 429)
        data = body(4096)
        if data is None:
            return err("too_large", 413)
        try:
            room, p = reg.join(code.upper(), data.get("name"), client_ip())
        except KeyError:
            return err("room_not_found", 404)
        except OverflowError:
            return err("room_full", 409)
        return jsonify({"ok": True, "roomId": room.code, "participantId": p.id, "token": p.token,
                        "slot": p.slot, "isHost": False, "maxParticipants": MAX_PARTICIPANTS})

    # ── the event stream ───────────────────────────────────────────────────────
    @bp.route("/rooms/<code>/events")
    def k_events(code):
        try:
            room, me = reg.auth(code.upper(), request.args.get("pid"), request.args.get("token"))
        except KeyError:
            return err("room_not_found", 404)
        except PermissionError:
            return err("forbidden", 403)

        with reg.lock:
            # A reconnect (EventSource retries on its own) replaces the old stream: the old
            # generator gets a sentinel on ITS queue and exits, the new one gets a fresh queue.
            # Whatever was queued and not yet delivered moves over — on the FIRST connect that
            # is everything sent between the join and the stream opening (typically the first
            # WebRTC offers from people already in the room), which must not be lost.
            old_q = me.queue
            new_q = queue.Queue(maxsize=QUEUE_MAX)
            while True:
                try:
                    item = old_q.get_nowait()
                except queue.Empty:
                    break
                if item is not None:
                    try:
                        new_q.put_nowait(item)
                    except queue.Full:
                        break
            me.queue = new_q
            if me.streams > 0:
                try:
                    old_q.put_nowait(None)
                except queue.Full:
                    pass
            my_q = new_q
            me.streams += 1
            snap = reg.snapshot(room, me)
            reg._broadcast_roster(room)   # "connected" flag changed

        def fmt(etype: str, data) -> str:
            return f"event: {etype}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"

        def gen():
            try:
                yield "retry: 2000\n\n"
                yield fmt("snapshot", snap)
                while True:
                    try:
                        ev = my_q.get(timeout=KEEPALIVE_S)
                    except queue.Empty:
                        yield ": keepalive\n\n"
                        continue
                    if ev is None:
                        break
                    yield fmt(ev["type"], ev["data"])
                    if ev["type"] in ("closed", "kicked", "bye"):
                        break
            finally:
                with reg.lock:
                    me.streams = max(0, me.streams - 1)
                    me.last_seen = time.time()
                    if not room.closed and me.id in room.participants:
                        reg._broadcast_roster(room)

        resp = Response(stream_with_context(gen()), mimetype="text/event-stream")
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["X-Accel-Buffering"] = "no"   # nginx in front of a relay: don't buffer
        return resp

    # ── member actions ─────────────────────────────────────────────────────────
    def member_action(code, limit, fn):
        data = body(limit)
        if data is None:
            return err("too_large", 413)
        try:
            room, me = with_member(code, data)
        except KeyError:
            return err("room_not_found", 404)
        except PermissionError:
            return err("forbidden", 403)
        return fn(room, me, data)

    @bp.route("/rooms/<code>/signal", methods=["POST"])
    def k_signal(code):
        def act(room, me, data):
            to = data.get("to")
            payload = data.get("data")
            if not isinstance(payload, dict):
                return err("bad_request", 400)
            with reg.lock:
                if to not in room.participants or to == me.id:
                    return err("unknown_peer", 404)
                reg.emit(room, "signal", {"from": me.id, "data": payload}, only=to)
            return jsonify({"ok": True})
        return member_action(code, MAX_SIGNAL_BYTES, act)

    @bp.route("/rooms/<code>/playback", methods=["POST"])
    def k_playback(code):
        def act(room, me, data):
            if not me.is_host:
                return err("host_only", 403)
            st = data.get("state")
            if not isinstance(st, dict):
                return err("bad_request", 400)
            now = time.time()
            with reg.lock:
                if now - room.last_playback_at < PLAYBACK_MIN_INTERVAL_S and not data.get("force"):
                    return jsonify({"ok": True, "throttled": True})
                room.last_playback_at = now
                track = st.get("track") if isinstance(st.get("track"), dict) else None
                state = {
                    "track": track,
                    "position": float(st.get("position") or 0),
                    "isPlaying": bool(st.get("isPlaying")),
                    # When the host sampled `position`, on the SERVER's clock (host-corrected).
                    "at": int(st.get("at") or _now_ms()),
                    "lyricsOffset": float(st.get("lyricsOffset") or 0),
                    "seq": int(st.get("seq") or 0),
                }
                room.playback = state
                reg.emit(room, "playback", state, exclude=me.id)
            return jsonify({"ok": True})
        return member_action(code, MAX_PLAYBACK_BYTES, act)

    @bp.route("/rooms/<code>/lyrics", methods=["POST"])
    def k_lyrics(code):
        def act(room, me, data):
            if not me.is_host:
                return err("host_only", 403)
            lines = data.get("lines")
            if lines is not None and not isinstance(lines, list):
                return err("bad_request", 400)
            lyr = {"videoId": str(data.get("videoId") or "")[:32],
                   "source": str(data.get("source") or "")[:64],
                   "lines": lines or [],
                   "status": str(data.get("status") or ("ok" if lines else "none"))[:16]}
            with reg.lock:
                room.lyrics = lyr
                reg.emit(room, "lyrics", lyr, exclude=me.id)
            return jsonify({"ok": True})
        return member_action(code, MAX_LYRICS_BYTES, act)

    @bp.route("/rooms/<code>/mic", methods=["POST"])
    def k_mic(code):
        def act(room, me, data):
            with reg.lock:
                me.muted = bool(data.get("muted"))
                reg.emit(room, "mic", {"id": me.id, "muted": me.muted})
            return jsonify({"ok": True})
        return member_action(code, 4096, act)

    @bp.route("/rooms/<code>/kick", methods=["POST"])
    def k_kick(code):
        def act(room, me, data):
            if not me.is_host:
                return err("host_only", 403)
            target = data.get("target")
            if target == me.id or target not in room.participants:
                return err("unknown_peer", 404)
            reg.remove(room, target, "kicked")
            return jsonify({"ok": True})
        return member_action(code, 4096, act)

    @bp.route("/rooms/<code>/leave", methods=["POST"])
    def k_leave(code):
        def act(room, me, data):
            reg.remove(room, me.id, "left")
            return jsonify({"ok": True})
        return member_action(code, 4096, act)

    # ── proxy to a remote room server (guests) ──────────────────────────────────
    # A guest's webview could talk to the host directly, but its page is served from
    # tauri://localhost (macOS/Linux) or https://tauri.localhost — a secure origin — and plain
    # http://192.168.x.x is then mixed content that WebKit blocks outright. localhost is exempt,
    # so the window talks to its OWN kodama-server, which forwards to the host. That also keeps
    # the app's CSP at "localhost:9847 only". Restricted to this machine's own requests and to
    # /karaoke/ paths, so it cannot be used to reach anything but another room server.
    if enable_proxy:
        @bp.route("/via", methods=["GET", "POST"])
        def k_via():
            if not is_local():
                return err("forbidden", 403)
            from urllib.parse import urlsplit
            import requests as _rq
            target = request.args.get("url", "")
            parts = urlsplit(target)
            if parts.scheme not in ("http", "https") or not parts.hostname \
                    or not parts.path.startswith("/karaoke/") or ".." in parts.path:
                return err("bad_target", 400)
            is_stream = parts.path.endswith("/events")
            try:
                if request.method == "POST":
                    up = _rq.post(target, data=request.get_data(), timeout=(5, 20),
                                  headers={"Content-Type": request.content_type or "application/json"})
                else:
                    up = _rq.get(target, stream=is_stream, timeout=(5, None if is_stream else 20),
                                 headers={"Accept": "text/event-stream"} if is_stream else None)
            except _rq.RequestException:
                return err("unreachable", 502)

            if not is_stream or up.status_code != 200:
                return Response(up.content, status=up.status_code,
                                content_type=up.headers.get("Content-Type", "application/json"))

            def relay_stream():
                try:
                    for chunk in up.iter_content(chunk_size=None):
                        if chunk:
                            yield chunk
                finally:
                    up.close()

            resp = Response(stream_with_context(relay_stream()), mimetype="text/event-stream")
            resp.headers["Cache-Control"] = "no-cache"
            return resp

    bp.registry = reg  # exposed for tests / diagnostics
    return bp


# ── stand-alone relay ─────────────────────────────────────────────────────────
def _main():
    import argparse
    from flask import Flask
    from werkzeug.serving import make_server

    ap = argparse.ArgumentParser(description="Kodama Live Karaoke relay server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=9847)
    ap.add_argument("--max-rooms", type=int, default=200)
    ap.add_argument("--relay", action="store_true",
                    help="allow anyone who can reach this server to create rooms")
    ap.add_argument("--proxy", action="store_true",
                    help="also serve /karaoke/via (what kodama-server does for its own window); "
                         "only useful for local testing")
    args = ap.parse_args()

    app = Flask("kodama_karaoke_relay")
    try:
        from flask_cors import CORS
        CORS(app, origins=["http://localhost:1421", "tauri://localhost", "https://tauri.localhost",
                           "http://tauri.localhost"])
    except ImportError:
        @app.after_request
        def _cors(resp):
            origin = request.headers.get("Origin", "")
            if origin in ("http://localhost:1421", "tauri://localhost", "https://tauri.localhost",
                          "http://tauri.localhost"):
                resp.headers["Access-Control-Allow-Origin"] = origin
                resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
                resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            return resp

    def _local():
        ra = request.remote_addr or ""
        return ra.startswith("127.") or ra == "::1"

    app.register_blueprint(create_blueprint(
        is_local=_local, allow_remote_create=args.relay, max_rooms=args.max_rooms,
        port=args.port, relay=True, enable_proxy=args.proxy))
    print(f"[karaoke] relay listening on {args.host}:{args.port} "
          f"(remote create: {'on' if args.relay else 'off'}, max rooms {args.max_rooms})")
    make_server(args.host, args.port, app, threaded=True).serve_forever()


if __name__ == "__main__":
    _main()
