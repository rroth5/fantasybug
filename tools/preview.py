#!/usr/bin/env python3
"""Preview fantasybug's pages in a browser, with no TV and no ESPN login.

    python3 tools/preview.py [port]          (default 8770)

Then open:
    http://localhost:8770/overlay.html?replay=week&standin=1          the sample week, played back
    http://localhost:8770/overlay.html?snapshot=week&at=110&box=1&standin=1&league=1   a still, box score open
    http://localhost:8770/setup.html?k=preview                        the phone setup page
    http://localhost:8770/remote.html?k=remote                        the phone remote

It serves web/ and stands in for the TV app: espn/league answers with a made-up league (the sample week's
two teams plus four more), and the setup page's /api calls are kept in memory. Nothing goes to ESPN.
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
KEY = "preview"

with open(os.path.join(WEB, "sample-week.json")) as f:
    SAMPLE = json.load(f)

# A made-up league around the sample week's two teams
TEAMS = [
    (1, SAMPLE["me"]["name"], SAMPLE["me"]["abbrev"], "Sam", "Sample", (6, 3)),
    (2, SAMPLE["them"]["name"], SAMPLE["them"]["abbrev"], "Casey", "Demo", (5, 4)),
    (3, "Fourth and Forever", "4TH", "Robin", "Placeholder", (7, 2)),
    (4, "Pylon Pirates", "PYL", "Jamie", "Testcase", (4, 5)),
    (5, "Taco Tuesday Tacklers", "TTT", "Morgan", "Mockup", (3, 6)),
    (6, "Waiver Wire Wizards", "WWW", "Riley", "Fixture", (2, 7)),
]


def league(views):
    week = SAMPLE["week"]
    d = {
        "settings": {"name": SAMPLE["league"], "scoringSettings": {"scoringItems": []}},
        "status": {"currentMatchupPeriod": week},
        "members": [{"id": "m%d" % t[0], "firstName": t[3], "lastName": t[4]} for t in TEAMS],
        "teams": [{"id": t[0], "name": t[1], "abbrev": t[2], "logo": "", "primaryOwner": "m%d" % t[0],
                   "record": {"overall": {"wins": t[5][0], "losses": t[5][1], "ties": 0}}} for t in TEAMS],
    }
    if "mMatchupScore" in views:
        side = lambda tid, pts, proj, win: {"teamId": tid, "totalPoints": pts, "totalPointsLive": pts,
                                            "totalProjectedPointsLive": proj, "winProbability": win}
        d["schedule"] = [
            {"matchupPeriodId": week, "home": side(1, SAMPLE["me"]["official"], SAMPLE["me"]["official"], 1),
             "away": side(2, SAMPLE["them"]["official"], SAMPLE["them"]["official"], 0), "winner": "HOME"},
            {"matchupPeriodId": week, "home": side(3, 104.6, 104.6, 1), "away": side(4, 98.2, 98.2, 0), "winner": "HOME"},
            {"matchupPeriodId": week, "home": side(5, 87.9, 87.9, 0), "away": side(6, 121.3, 121.3, 1), "winner": "AWAY"},
        ]
    return d


STATE = {"league_id": "", "signed_in": False, "private": False, "team_id": None, "team_name": "", "delay_s": 58,
         "popups": {k: True for k in ("plays", "touchdowns", "redzone", "lead", "final")}}
VIEW = {"view": "off", "tv": "", "quality": "med", "look": {"look": "pill", "pos": "tr", "nx": 50},
        "lineup": {"on": False, "pos": "ml", "both": False}}
SYNC = {"games": [{"gid": "1", "name": "JAX @ BAL", "delay": 58, "synced": False}, {"gid": "2", "name": "LAR @ WSH", "delay": 58, "synced": False}],
        "target": {"id": 7, "play": "Trevor Lawrence's 4 yd pass to P. Washington", "game": "JAX @ BAL"}, "pick": None, "undo": None,
        "recent": [{"play": "Puka Nacua's 7 yd TD catch", "game": "LAR @ WSH", "ago": 95}]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.endswith("/espn/league"):
            return self.send_json(league(u.query))
        if u.path.endswith("/espn/logo"):
            return self.send_json({}, 404)
        if u.path == "/config.js":
            body = ("window.FANTASYBUG = %s;\n" % json.dumps({"delay_s": 58})).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if u.path.startswith("/api/"):
            return self.api(u.path, {})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if u.path.startswith("/api/"):
            return self.api(u.path, body)
        self.send_error(405)

    def remote_state(self):
        on = VIEW["view"] != "off"
        return self.send_json({"view": VIEW["view"], "ready": STATE["team_id"] is not None, "can_draw": True, "def": STATE["delay_s"],
                               "tv": VIEW["tv"], "quality": VIEW["quality"], "look": VIEW["look"], "lineup": VIEW["lineup"],
                               "espn": {"ok": True}, "score": {"me": "GRM", "them": "BLZ", "a": 115.3, "b": 74.6} if on else None,
                               "games": SYNC["games"] if on else [], "target": SYNC["target"] if on else None, "pick": SYNC["pick"],
                               "canUndo": bool(SYNC.get("undo")), "recent": SYNC["recent"] if on else []})

    def api(self, path, b):
        if self.headers.get("X-Key") == "remote":   # the phone remote (its own server on the TV)
            return self.remote_api(path, b)
        if self.headers.get("X-Key") != KEY:
            return self.send_json({"error": "This link has expired. Scan the QR code on the TV again."}, 403)
        teams = lambda: [{"id": t[0], "name": t[1], "abbrev": t[2], "owner": t[3] + " " + t[4]} for t in TEAMS]
        if path == "/api/state":
            return self.send_json(dict(STATE, remote_url="/remote.html?k=remote"))
        if path == "/api/login":
            lid = str(b.get("league_id", "")).strip()
            if not lid.isdigit():
                return self.send_json({"error": "Check the league ID (digits only), and paste both espn_s2 and SWID, or neither for a public league."}, 400)
            STATE.update(league_id=lid, signed_in=True, private=bool(b.get("espn_s2")))
            return self.send_json(dict(STATE, league=SAMPLE["league"], teams=teams()))
        if path == "/api/teams":
            return self.send_json(dict(STATE, league=SAMPLE["league"], teams=teams()))
        return self.setup_api(path, b)

    def remote_api(self, path, b):
        # the phone remote, with a pretend tap-to-sync (the real one is FantasySync in overlay-live.js)
        if path == "/api/state":
            return self.remote_state()
        if path == "/api/view":
            v = b.get("view") or b.get("mode")
            if v in ("bug", "box", "league", "off"):
                VIEW["view"] = v
            return self.send_json({"ok": True, "view": VIEW["view"]})
        if path == "/api/look":
            VIEW["look"] = {"look": b.get("look", "pill"), "pos": b.get("pos", "tr"), "nx": int(b.get("nx", 50))}
            return self.send_json(VIEW["look"])
        if path == "/api/quality":
            VIEW["quality"] = b.get("q", "med")
            return self.send_json({"ok": True, "quality": VIEW["quality"]})
        if path == "/api/lineup":
            VIEW["lineup"].update({k: b[k] for k in ("on", "pos", "both") if k in b})
            return self.send_json(VIEW["lineup"])
        if path == "/api/name":
            VIEW["tv"] = str(b.get("name", ""))[:24]
            return self.remote_state()
        if path == "/api/tap" and not b.get("id"):
            SYNC["pick"] = [{"id": "p:1:9", "play": "T.Lawrence pass short right to P.Washington to JAX 44 for 7 yards", "game": "JAX @ BAL", "before": 4},
                            {"id": "p:2:4", "play": "M.Stafford pass short middle to P.Nacua for 7 yards, TOUCHDOWN", "game": "LAR @ WSH", "before": 22}]
            return self.send_json({"ok": True, "pick": True})
        if path in ("/api/tap", "/api/choose"):
            SYNC["pick"] = None
            g = SYNC["games"][0]
            SYNC["undo"] = (g["delay"], g["synced"])
            before, g["delay"], g["synced"] = g["delay"], 31, True
            return self.send_json({"ok": True, "play": SYNC["target"]["play"], "game": g["name"], "before": before, "after": 31})
        if path == "/api/nudge":
            for g in SYNC["games"]:
                if g["gid"] == b.get("gid"):
                    g["delay"] += int(b.get("s", 0)); g["synced"] = True
            return self.remote_state()
        if path == "/api/undo":
            if SYNC.get("undo"):
                SYNC["games"][0]["delay"], SYNC["games"][0]["synced"] = SYNC["undo"]; SYNC["undo"] = None
            return self.remote_state()
        if path == "/api/reset":
            for g in SYNC["games"]:
                g["delay"], g["synced"] = STATE["delay_s"], False
            return self.remote_state()
        self.send_json({"error": "Not found"}, 404)

    def setup_api(self, path, b):
        if path == "/api/settings":
            if "team_id" in b:
                STATE.update(team_id=b["team_id"], team_name=b.get("team_name", ""))
            if "delay_s" in b:
                STATE["delay_s"] = max(0, min(300, int(b["delay_s"])))
            STATE["popups"].update(b.get("popups") or {})
            return self.send_json(dict(STATE, remote_url="/remote.html?k=remote"))
        if path == "/api/forget":
            STATE.update(league_id="", signed_in=False, private=False, team_id=None, team_name="")
            return self.send_json(STATE)
        self.send_json({"error": "Not found"}, 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    print("fantasybug preview on http://localhost:%d/overlay.html?replay=week&standin=1" % port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
