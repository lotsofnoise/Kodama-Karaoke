"""Tests for the Live Karaoke room server.  Run:  python -m pytest python-backend/tests -q"""
import json
import os
import sys
import threading

import pytest
from flask import Flask, request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import karaoke_room as kr  # noqa: E402

LOCAL = {"REMOTE_ADDR": "127.0.0.1"}


def make_app(**kw):
    app = Flask("t")

    def is_local():
        ra = request.remote_addr or ""
        return ra.startswith("127.")

    bp = kr.create_blueprint(is_local=is_local, lan_ips=lambda: ["192.168.1.20"], **kw)
    app.register_blueprint(bp)
    return app, bp.registry


def lan(n):
    return {"REMOTE_ADDR": f"192.168.1.{100 + n}"}


def create(c, name="Host"):
    r = c.post("/karaoke/rooms", json={"name": name}, environ_base=LOCAL)
    assert r.status_code == 200, r.data
    return r.get_json()


def join(c, code, name, n=1):
    return c.post(f"/karaoke/rooms/{code}/join", json={"name": name}, environ_base=lan(n))


def read_events(resp, count):
    """Pull `count` SSE events (skipping comments) off a streaming test response."""
    out, buf = [], ""
    it = iter(resp.response)
    while len(out) < count:
        chunk = next(it)
        buf += chunk.decode() if isinstance(chunk, bytes) else chunk
        while "\n\n" in buf:
            block, buf = buf.split("\n\n", 1)
            if block.startswith(":") or block.startswith("retry"):
                continue
            etype = data = None
            for line in block.split("\n"):
                if line.startswith("event: "):
                    etype = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
            out.append((etype, data))
    return out


def test_create_is_local_only():
    app, _ = make_app()
    c = app.test_client()
    r = c.post("/karaoke/rooms", json={"name": "x"}, environ_base=lan(1))
    assert r.status_code == 403
    d = create(c)
    assert len(d["roomId"]) == kr.ROOM_CODE_LEN
    assert set(d["roomId"]) <= set(kr.ROOM_CODE_ALPHABET)
    assert d["maxParticipants"] == 5 and d["isHost"] and d["slot"] == 0
    assert d["lan"]["ips"] == ["192.168.1.20"]


def test_relay_mode_allows_remote_create():
    app, _ = make_app(allow_remote_create=True, max_rooms=2)
    c = app.test_client()
    assert c.post("/karaoke/rooms", json={}, environ_base=lan(1)).status_code == 200
    assert c.post("/karaoke/rooms", json={}, environ_base=lan(2)).status_code == 200
    assert c.post("/karaoke/rooms", json={}, environ_base=lan(3)).status_code == 503


def test_hard_cap_of_five():
    app, reg = make_app()
    c = app.test_client()
    code = create(c)["roomId"]
    slots = []
    for i in range(4):
        r = join(c, code, f"Guest {i}", i)
        assert r.status_code == 200
        slots.append(r.get_json()["slot"])
    assert sorted(slots) == [1, 2, 3, 4]
    r = join(c, code, "Sixth", 9)
    assert r.status_code == 409 and r.get_json()["error"] == "room_full"
    assert len(reg.rooms[code].participants) == 5
    info = c.get(f"/karaoke/rooms/{code}", environ_base=lan(9)).get_json()
    assert info["full"] and info["count"] == 5


def test_cap_holds_under_concurrent_joins():
    app, reg = make_app()
    code = create(app.test_client())["roomId"]
    results = []

    def worker(i):
        c = app.test_client()
        results.append(join(c, code, f"g{i}", i).status_code)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(200) == 4
    assert results.count(409) == 16
    assert len(reg.rooms[code].participants) == 5


def test_slot_reused_after_leave_and_wrong_token_rejected():
    app, _ = make_app()
    c = app.test_client()
    code = create(c)["roomId"]
    g = join(c, code, "A", 1).get_json()
    assert c.post(f"/karaoke/rooms/{code}/leave", json={"pid": g["participantId"], "token": "nope"},
                  environ_base=lan(1)).status_code == 403
    assert c.post(f"/karaoke/rooms/{code}/leave", json={"pid": g["participantId"], "token": g["token"]},
                  environ_base=lan(1)).status_code == 200
    assert join(c, code, "B", 2).get_json()["slot"] == 1


def test_leave_via_beacon_text_plain():
    app, reg = make_app()
    c = app.test_client()
    code = create(c)["roomId"]
    g = join(c, code, "A", 1).get_json()
    r = c.post(f"/karaoke/rooms/{code}/leave", data=json.dumps({"pid": g["participantId"], "token": g["token"]}),
               content_type="text/plain", environ_base=lan(1))
    assert r.status_code == 200
    assert g["participantId"] not in reg.rooms[code].participants


def test_host_only_playback_and_lyrics_and_snapshot():
    app, _ = make_app()
    c = app.test_client()
    h = create(c)
    code = h["roomId"]
    g = join(c, code, "Guest", 1).get_json()
    auth_g = {"pid": g["participantId"], "token": g["token"]}
    auth_h = {"pid": h["participantId"], "token": h["token"]}
    st = {"track": {"videoId": "abc", "title": "Song"}, "position": 12.5, "isPlaying": True, "at": 1000, "seq": 1}
    assert c.post(f"/karaoke/rooms/{code}/playback", json={**auth_g, "state": st}, environ_base=lan(1)).status_code == 403
    assert c.post(f"/karaoke/rooms/{code}/playback", json={**auth_h, "state": st, "force": True}, environ_base=LOCAL).status_code == 200
    lines = [{"time": 1.0, "text": "hello world", "words": [{"text": "hello", "time": 1.0, "end": 1.4}]}]
    assert c.post(f"/karaoke/rooms/{code}/lyrics", json={**auth_g, "videoId": "abc", "lines": lines}, environ_base=lan(1)).status_code == 403
    assert c.post(f"/karaoke/rooms/{code}/lyrics", json={**auth_h, "videoId": "abc", "lines": lines}, environ_base=LOCAL).status_code == 200

    # A late joiner gets everything in the snapshot.
    late = join(c, code, "Late", 2).get_json()
    resp = c.get(f"/karaoke/rooms/{code}/events?pid={late['participantId']}&token={late['token']}",
                 environ_base=lan(2), buffered=False)
    (etype, snap), = read_events(resp, 1)
    assert etype == "snapshot"
    assert snap["playback"]["track"]["videoId"] == "abc"
    assert snap["playback"]["position"] == 12.5
    assert snap["lyrics"]["lines"][0]["words"][0]["text"] == "hello"
    assert [p["slot"] for p in snap["participants"]] == [0, 1, 2]
    resp.close()


def test_signal_relay_and_mic_and_close_on_host_leave():
    app, reg = make_app()
    c = app.test_client()
    h = create(c)
    code = h["roomId"]
    g = join(c, code, "Guest", 1).get_json()
    resp = c.get(f"/karaoke/rooms/{code}/events?pid={g['participantId']}&token={g['token']}",
                 environ_base=lan(1), buffered=False)
    assert read_events(resp, 1)[0][0] == "snapshot"

    auth_h = {"pid": h["participantId"], "token": h["token"]}
    offer = {"kind": "offer", "sdp": "v=0..."}
    r = c.post(f"/karaoke/rooms/{code}/signal", json={**auth_h, "to": g["participantId"], "data": offer}, environ_base=LOCAL)
    assert r.status_code == 200
    c.post(f"/karaoke/rooms/{code}/mic", json={**auth_h, "muted": True}, environ_base=LOCAL)
    c.post(f"/karaoke/rooms/{code}/leave", json=auth_h, environ_base=LOCAL)

    events = read_events(resp, 5)
    types = [e[0] for e in events]
    # roster updates (own join + stream connected), the relayed offer, the mic change, closed
    assert "signal" in types and "mic" in types and types[-1] == "closed"
    sig = next(d for t, d in events if t == "signal")
    assert sig["from"] == h["participantId"] and sig["data"] == offer
    mic = next(d for t, d in events if t == "mic")
    assert mic == {"id": h["participantId"], "muted": True}
    assert code not in reg.rooms
    resp.close()


def test_signals_sent_before_stream_opens_are_delivered():
    """A newcomer gets offers from people already inside right after joining, usually before
    its EventSource is connected. Those must survive the stream opening."""
    app, _ = make_app()
    c = app.test_client()
    h = create(c)
    code = h["roomId"]
    g = join(c, code, "Guest", 1).get_json()
    offer = {"kind": "offer", "sdp": "early"}
    c.post(f"/karaoke/rooms/{code}/signal", json={"pid": h["participantId"], "token": h["token"],
                                                  "to": g["participantId"], "data": offer}, environ_base=LOCAL)
    resp = c.get(f"/karaoke/rooms/{code}/events?pid={g['participantId']}&token={g['token']}",
                 environ_base=lan(1), buffered=False)
    events = read_events(resp, 3)
    assert ("signal", {"from": h["participantId"], "data": offer}) in events
    resp.close()


def test_payload_limits():
    app, _ = make_app()
    c = app.test_client()
    h = create(c)
    code = h["roomId"]
    g = join(c, code, "G", 1).get_json()
    big = {"pid": h["participantId"], "token": h["token"], "to": g["participantId"],
           "data": {"sdp": "x" * (kr.MAX_SIGNAL_BYTES + 10)}}
    assert c.post(f"/karaoke/rooms/{code}/signal", json=big, environ_base=LOCAL).status_code == 413


def test_join_rate_limit():
    app, _ = make_app()
    c = app.test_client()
    for _ in range(kr.RATE_MAX):
        assert c.get("/karaoke/rooms/ZZZZZZ", environ_base=lan(7)).status_code == 404
    assert c.get("/karaoke/rooms/ZZZZZZ", environ_base=lan(7)).status_code == 429


def test_new_create_replaces_old_local_room():
    app, reg = make_app()
    c = app.test_client()
    a = create(c)["roomId"]
    b = create(c)["roomId"]
    assert a not in reg.rooms and b in reg.rooms


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
