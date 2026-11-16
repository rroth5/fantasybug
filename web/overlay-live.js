// The live engine behind the fantasy overlay (overlay.js): your ESPN Fantasy matchup, scored as the plays
// happen from ESPN's public game feeds, and checked against ESPN Fantasy itself.
//
// - ESPN Fantasy (espn/league, through whatever serves this page, which adds the login cookies), every
//   minute: both lineups, projections, each player's official points, ESPN's win probability, and the
//   league's own scoring rules.
// - ESPN's public NFL scoreboard every 30 seconds (15 while a starter's game is on): which games are on.
// - Every live game a starter is in, checked every 5 seconds: its play count (a small request), and its box
//   score and plays (a big one) when that count moves, and every 60 seconds anyway. Each starter's points with the
//   league's rules (FantasyScoring below; checked to match ESPN Fantasy exactly on weeks 1-9 of 2026,
//   1,817 player-games: checked against ESPN Fantasy).
// - Each player shows the fast feed's number. If ESPN Fantasy still says something else three minutes
//   later, ESPN Fantasy wins (a stat correction, a play the feed missed). A team defence, and every
//   player whose game is over and whom ESPN Fantasy has caught up on, shows ESPN Fantasy's number.
// - Every play that scores for a starter gets its own flash (playPoints: that play's points and caption),
//   held until the broadcast shows it: ESPN's time stamp on the play plus DELAY (a stream runs about a
//   minute behind ESPN). The box score stays the truth for totals: once it has held still long enough for
//   every play to have been shown, any difference left is settled (settle).
// - Each live game is replayed from its play-by-play as of DELAY ago (who has the ball, the down, the score,
//   the red zone), not taken from ESPN's scoreboard: that runs ahead of the broadcast, and calls the extra
//   point after a long touchdown a red zone trip.
//
// Started by overlay.html?live=1 (the team and delay from window.FANTASYBUG, which the app writes into
// config.js from its settings, or &team=<name>&delay=<seconds>).
(function () {
  "use strict";

  // ---------------- scoring: ESPN Fantasy's rules applied to ESPN's box score, and each play from the play-by-play
  var SUFFIX = { "jr.": 1, "jr": 1, "sr.": 1, "ii": 1, "iii": 1, "iv": 1, "v": 1 };
  var NAME = "([A-Z][a-z]{0,2})\\.\\s?((?:St\\.\\s?)?[A-Z][A-Za-z'\\-]+)";
  var FG = /(\d+)\s*(?:Yd|yard)s?\s+field goal/i;
  var KICK = new RegExp(NAME + "\\s+\\d+\\s*(?:Yd|yard)s?\\s+field goal", "i");
  var TWO_PT = /TWO-POINT CONVERSION ATTEMPT\.\s*([\s\S]*?)ATTEMPT (SUCCEEDS|FAILS)/i;
  var TWO_PASS = new RegExp(NAME + " pass to " + NAME);
  var TWO_RUN = new RegExp(NAME + " (?:rushes|scrambles|left|right|up the middle)");
  var TWO_FULL_PASS = /\(([A-Z][\w.'\- ]+?) Pass to ([A-Z][\w.'\- ]+?) for Two-Point Conversion\)/;
  var TWO_FULL_RUN = /\(([A-Z][\w.'\- ]+?) Run for Two-Point Conversion\)/;
  var PASS = new RegExp(NAME + " pass (?:[a-z]+ ){0,3}to " + NAME);
  var RUSH = new RegExp("^" + NAME + " (?:scrambles |kneels |left |right |up |to |for |rushes |pushed |sneaks )");
  var LEAD = /^(?:\([^)]*\)\s*)*(?:[^.]*reported in as eligible\.\s*)*/;

  function Rules(items) {
    var by = {};
    (items || []).forEach(function (r) { by[r.statId] = r; });
    return function (statId, n) { var r = by[statId]; return r ? r.points * n : 0; };
  }
  function words(name) { return name.split(/\s+/).filter(function (w) { return !SUFFIX[w.toLowerCase()]; }); }
  function num(s) { var v = parseFloat(s); return isNaN(v) ? 0 : v; }

  // Everyone in one game's box score, to find who a play's short name ("A.St. Brown", "Bi.Robinson") means
  function Roster(summary) {
    var people = [], full = {};
    ((summary.boxscore || {}).players || []).forEach(function (team) {
      team.statistics.forEach(function (cat) {
        cat.athletes.forEach(function (a) {
          var w = words(a.athlete.displayName), id = +a.athlete.id;
          people.push({ first: w[0], sur: w.slice(1).join(" ").toLowerCase(), id: id, kicker: cat.name === "kicking" });
          full[w.join(" ").toLowerCase()] = id;
        });
      });
    });
    function find(init, last, kickersOnly) {
      last = last.toLowerCase().replace("st.", "st. ").replace(/\s+/g, " ").trim();
      var lastWord = last.split(" ").pop(), exact = {}, loose = {};
      people.forEach(function (p) {
        if (kickersOnly && !p.kicker || p.first.indexOf(init) !== 0) return;
        if (p.sur === last) exact[p.id] = 1;
        else if (p.sur.split(" ").pop() === lastWord) loose[p.id] = 1;
      });
      // the whole surname first: "A.St. Brown" is Amon-Ra St. Brown, not A.J. Brown in the same game
      var ids = Object.keys(exact).length ? Object.keys(exact) : Object.keys(loose);
      return ids.length === 1 ? +ids[0] : null;
    }
    return {
      find: find,
      full: function (name) { return full[words(name).join(" ").toLowerCase()] || null; }
    };
  }

  // athlete id -> fantasy points, from one game's box score and its plays (field goals by distance, missed
  // kicks and two-point conversions are not split out in the box score)
  function boxPoints(summary, pts) {
    var lines = {}, extra = {}, roster = Roster(summary);
    ((summary.boxscore || {}).players || []).forEach(function (team) {
      team.statistics.forEach(function (cat) {
        cat.athletes.forEach(function (a) {
          var row = lines[+a.athlete.id] || (lines[+a.athlete.id] = {});
          cat.labels.forEach(function (label, i) {
            var v = a.stats[i] || "";
            if (label === "C/ATT" || ((label === "FG" || label === "XP") && v.indexOf("/") > 0)) {
              var p = v.split("/");
              row[cat.name + "." + label + "_made"] = num(p[0]);
              row[cat.name + "." + label + "_att"] = num(p[1]);
            } else row[cat.name + "." + label] = num(v);
          });
        });
      });
    });
    function add(id, statId) { if (id) { var e = extra[id] || (extra[id] = {}); e[statId] = (e[statId] || 0) + 1; } }
    plays(summary).forEach(function (p) {
      var text = (p.text || "").trim(), typ = (p.type || {}).text || "", wiped = text.indexOf("No Play") >= 0;
      var two = TWO_PT.exec(text), m;
      if (two && two[2].toUpperCase() === "SUCCEEDS" && !wiped) {
        if ((m = TWO_PASS.exec(two[1]))) { add(roster.find(m[1], m[2]), 19); add(roster.find(m[3], m[4]), 44); }
        else if ((m = TWO_RUN.exec(two[1]))) add(roster.find(m[1], m[2]), 26);
      } else if (!two && !wiped) {
        if ((m = TWO_FULL_PASS.exec(text))) { add(roster.full(m[1]), 19); add(roster.full(m[2]), 44); }
        if ((m = TWO_FULL_RUN.exec(text))) add(roster.full(m[1]), 26);
      }
      var k = KICK.exec(text), kicker = k ? roster.find(k[1], k[2], true) : null;
      if (typ === "Field Goal Good") {
        var d = FG.exec(text);
        if (d && kicker) { var n = +d[1]; add(kicker, n < 40 ? 80 : n < 50 ? 77 : n < 60 ? 198 : 201); }
      } else if ((typ === "Field Goal Missed" || typ === "Blocked Field Goal") && kicker) add(kicker, 85);
    });
    var out = {};
    Object.keys(lines).forEach(function (id) {
      var g = function (k) { return lines[id][k] || 0; }, p = 0;
      p += pts(3, g("passing.YDS")) + pts(4, g("passing.TD")) + pts(20, g("passing.INT"));
      p += pts(24, g("rushing.YDS")) + pts(25, g("rushing.TD"));
      p += pts(53, g("receiving.REC")) + pts(42, g("receiving.YDS")) + pts(43, g("receiving.TD"));
      p += pts(72, g("fumbles.LOST"));
      p += pts(101, g("kickReturns.TD")) + pts(102, g("puntReturns.TD"));
      p += pts(86, g("kicking.XP_made"));
      var e = extra[id] || {};
      Object.keys(e).forEach(function (s) { p += pts(+s, e[s]); });
      out[id] = Math.round(p * 100) / 100;
    });
    return out;
  }

  // A game's summary from ESPN is 0.4 to 0.7 MB (news, betting, standings, every play with 19 fields); the
  // overlay keeps only what it reads: who is home and away, the box score's lines, and each play's text, kind,
  // score, clock, spot and time stamp (t, read once). About a tenth of the size, and garbage sooner.
  function slim(s) {
    var comp = ((s.header || {}).competitions || [])[0] || {};
    var sp = function (x) { x = x || {}; return { down: x.down, team: { id: (x.team || {}).id }, yardsToEndzone: x.yardsToEndzone, downDistanceText: x.downDistanceText }; };
    return {
      header: { competitions: [{ status: { type: { state: ((comp.status || {}).type || {}).state } },
        competitors: (comp.competitors || []).map(function (c) { return { homeAway: c.homeAway, team: { id: c.team.id, abbreviation: c.team.abbreviation } }; }) }] },
      boxscore: { players: ((s.boxscore || {}).players || []).map(function (team) {
        return { statistics: (team.statistics || []).map(function (cat) {
          return { name: cat.name, labels: cat.labels || [], athletes: (cat.athletes || []).map(function (a) {
            return { athlete: { id: a.athlete.id, displayName: a.athlete.displayName }, stats: a.stats || [] };
          }) };
        }) };
      }) },
      drives: { previous: [{ plays: plays(s).map(function (p) {
        return { id: p.id, text: p.text, type: { text: (p.type || {}).text }, wallclock: p.wallclock, t: Date.parse(p.wallclock || "") || 0,
                 scoringPlay: p.scoringPlay, isTurnover: p.isTurnover, homeScore: p.homeScore, awayScore: p.awayScore,
                 period: { number: (p.period || {}).number }, clock: { displayValue: (p.clock || {}).displayValue }, start: sp(p.start), end: sp(p.end) };
      }) }] }
    };
  }
  function stamp(p) { return p.t != null ? p.t : Date.parse(p.wallclock || "") || 0; }   // ms, 0 if none

  function plays(summary) {   // every play once (the drive in progress is often also among the finished ones)
    var out = [], seen = {}, dr = summary.drives || {};
    var add = function (p) { if (!seen[p.id]) { seen[p.id] = 1; out.push(p); } };
    (dr.previous || []).forEach(function (d) { (d.plays || []).forEach(add); });
    if (dr.current && dr.current.plays) dr.current.plays.forEach(add);
    return out;
  }

  // Each player's fantasy points from one play, with a caption: [{ id, pts, cap }] (checked against ESPN Fantasy;
  // the box score stays the source of truth for totals, this only says what just happened)
  var YARDS = /for (-?\d+) yards?|for (no gain)/;
  function playPoints(p, roster, pts) {
    var text = (p.text || "").trim(), typ = (p.type || {}).text || "", out = [];
    if (text.indexOf("No Play") >= 0) return out;
    var body = text.replace(LEAD, ""), td = /TOUCHDOWN/.test(text) && !/NULLIFIED/.test(text), m;
    var yd = YARDS.exec(body), y = yd && !yd[2] ? +yd[1] : 0;
    var add = function (id, v, cap) { if (id && v) out.push({ id: id, pts: Math.round(v * 100) / 100, cap: cap }); };
    var fumbled = /^Fumble Recovery/.test(typ);   // a run or catch that ended in a fumble: still yards
    if (typ === "Pass Reception" || typ === "Passing Touchdown" || (fumbled && PASS.test(body))) {
      if ((m = PASS.exec(body))) {
        add(roster.find(m[1], m[2]), pts(3, y) + (td ? pts(4, 1) : 0), y + " yd pass" + (td ? " · TD" : ""));
        add(roster.find(m[3], m[4]), pts(53, 1) + pts(42, y) + (td ? pts(43, 1) : 0), (td ? "TD · " : "") + y + " yd catch");
      }
    } else if (typ === "Rush" || typ === "Rushing Touchdown" || fumbled) {
      if ((m = RUSH.exec(body))) add(roster.find(m[1], m[2]), pts(24, y) + (td ? pts(25, 1) : 0), (td ? "TD · " : "") + y + " yd run");
    } else if (typ === "Pass Interception Return" || typ === "Interception Return Touchdown") {
      if ((m = new RegExp("^" + NAME + " pass").exec(body))) add(roster.find(m[1], m[2]), pts(20, 1), "Interception");
    }
    if (typ === "Fumble Recovery (Opponent)" || typ === "Sack Opp Fumble Recovery") {
      if ((m = new RegExp(NAME + " FUMBLES").exec(text))) add(roster.find(m[1], m[2]), pts(72, 1), "Fumble lost");
    }
    if (typ === "Field Goal Good") {
      var d = FG.exec(text);
      if ((m = KICK.exec(text)) && d) { var n = +d[1]; add(roster.find(m[1], m[2], true), pts(n < 40 ? 80 : n < 50 ? 77 : n < 60 ? 198 : 201, 1), n + " yd field goal"); }
    } else if (typ === "Field Goal Missed" || typ === "Blocked Field Goal") {
      if ((m = KICK.exec(text))) add(roster.find(m[1], m[2], true), pts(85, 1), "Missed field goal");
    }
    if ((m = new RegExp(NAME + " extra point is GOOD").exec(text))) add(roster.find(m[1], m[2], true), pts(86, 1), "Extra point");
    var two = TWO_PT.exec(text);
    if (two && two[2].toUpperCase() === "SUCCEEDS") {
      if ((m = TWO_PASS.exec(two[1]))) { add(roster.find(m[1], m[2]), pts(19, 1), "2-pt pass"); add(roster.find(m[3], m[4]), pts(44, 1), "2-pt catch"); }
      else if ((m = TWO_RUN.exec(two[1]))) add(roster.find(m[1], m[2]), pts(26, 1), "2-pt run");
    } else if (!two) {
      if ((m = TWO_FULL_PASS.exec(text))) { add(roster.full(m[1]), pts(19, 1), "2-pt pass"); add(roster.full(m[2]), pts(44, 1), "2-pt catch"); }
      if ((m = TWO_FULL_RUN.exec(text))) add(roster.full(m[1]), pts(26, 1), "2-pt run");
    }
    return out;
  }

  window.FantasyScoring = { Rules: Rules, boxPoints: boxPoints, playPoints: playPoints, Roster: Roster, plays: plays, slim: slim };

  // ---------------- the live engine
  var Q = location.search;
  if (!/[?&]live=1/.test(Q) || !window.FantasyOverlay) return;
  var CFG = window.FANTASYBUG || {};
  var TEAM = decodeURIComponent(((/[?&]team=([^&]*)/.exec(Q) || [])[1] || "").replace(/\+/g, " ")) || (CFG.team_id == null ? CFG.team : "");
  if (!TEAM && CFG.team_id == null) return;
  var O = window.FantasyOverlay;
  var FANTASY_MS = 60000, BOARD_MS = 30000, BOARD_LIVE_MS = 15000, LIVE_MS = 5000, TRUST_MS = 3 * 60000, PLAY_WAIT_MS = 60000;
  // A live game's summary is fetched in full only when its play count (ESPN's core API, under 2 kB) has moved,
  // until the new play is in it, and at least every FULL_MS anyway (the box score, stat corrections); a
  // finished game's every POST_MS. Plays come about every 40 s, so most 5 s checks stay small. The count
  // moves first: 16 to 19 s before the play reached the summary, measured on a live game.
  var FULL_MS = 60000, POST_MS = 60000, NEW_PLAY_MS = 40000;
  var CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/";
  var DELAY = (+((/[?&]delay=(\d+)/.exec(Q) || [])[1] || (CFG.delay_s != null ? CFG.delay_s : 58))) * 1000;
  var summaries = {};       // ESPN game id -> its latest summary (box score and play-by-play)
  var pending = {};         // player id -> how many of their plays' flashes are on their way
  var done = {};            // "play id:player id": a flash scheduled, or the play was there before we looked
  var scanned = {};         // ESPN game id -> its plays have been looked at once
  var SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/";
  var SLOTS = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 23: "FLEX", 16: "D/ST", 17: "K" };
  var ORDER = [0, 2, 4, 6, 23, 16, 17];
  var POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

  var info = null;          // { me, opp, pts (rules), names, logos, period, abbrev: proTeamId -> "DET" }
  var players = {};         // id -> { side, name, short, pos, slot, pro, proTeam, proj, official, officialAt, fast, shown }
  var games = {};           // proTeamId -> { id, state: "pre"|"in"|"post", start, left (0..1) }
  var lastShown = null, lineupKey = "", shownPeriod = null, finalSent = false, lastChange = Date.now(), ranksAt = 0;
  var FINAL_QUIET_MS = 20 * 60000;   // every starter's game over and no change for this long: the final

  // "[timing]" lines in the console (adb logcat on the TV): when each play reached us, and how long after
  // ESPN stamped it, to line the popups up with the broadcast
  function tlog(what) { console.log("[timing] " + new Date().toTimeString().slice(0, 8) + " " + what); }
  function liveNow() {
    return Object.keys(players).some(function (id) { return (games[players[id].proTeam] || {}).state === "in"; });
  }

  function getJson(url, filter) {
    return fetch(url, { cache: "no-store", headers: filter ? { "X-Fantasy-Filter": JSON.stringify(filter) } : {} })
      .then(function (r) { if (!r.ok) throw new Error(url + " " + r.status); return r.json(); });
  }
  // the season ESPN is in: the year it started (a January playoff week is still last year's season)
  function season() { var d = new Date(); return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1; }
  function short(full) { var w = full.split(" "); return w[0][0] + ". " + w.slice(1).join(" "); }

  function loadInfo() {
    if (info && Date.now() - info.at < 3600000) return Promise.resolve(info);
    return Promise.all([
      getJson("espn/league?view=mTeam&view=mSettings"),
      getJson("https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season() + "?view=proTeamSchedules_wl").catch(function () { return null; })
    ]).then(function (r) {
      var d = r[0], me = (d.teams || []).filter(function (t) {   // the team picked in setup (by id: names change), or &team=<name>
        return TEAM ? (t.name || "").toUpperCase() === TEAM.toUpperCase() : t.id === +CFG.team_id;
      })[0];
      if (!me) throw new Error("no team " + (TEAM || CFG.team_id));
      var abbrev = {};
      if (r[1]) r[1].settings.proTeams.forEach(function (t) { abbrev[t.id] = t.abbrev; });
      var teams = {}, members = {};
      (d.members || []).forEach(function (m) { members[m.id] = m; });
      var title = function (s) { return (s || "").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); };
      d.teams.forEach(function (t) {
        var m = members[t.primaryOwner || (t.owners || [])[0]];   // the owner's name, for under the team's
        t.ownerName = m ? (title(m.firstName) + " " + title(m.lastName)).trim() || m.displayName : "";
        teams[t.id] = t;
      });
      info = { at: Date.now(), me: me.id, teams: teams, period: d.status.currentMatchupPeriod,
               pts: Rules(d.settings.scoringSettings.scoringItems), abbrev: abbrev, league: d.settings.name };
      return info;
    });
  }

  // ESPN Fantasy: lineups, projections, official points, win probability
  function pollFantasy() {
    return loadInfo().then(function (inf) {
      var filter = { schedule: { filterMatchupPeriodIds: { value: [inf.period] }, filterTeamIds: { value: [inf.me] } } };
      return getJson("espn/league?view=mMatchupScore&view=mBoxscore", filter).then(function (d) {
        var g = (d.schedule || [])[0];
        if (!g || !g.away) return;
        var mine = g.home.teamId === inf.me ? g.home : g.away, them = mine === g.home ? g.away : g.home;
        inf.opp = them.teamId;
        var seen = {}, lineup = { me: [], them: [] };
        [["me", mine], ["them", them]].forEach(function (x) {
          var entries = ((x[1].rosterForCurrentScoringPeriod || {}).entries || [])
            .filter(function (e) { return SLOTS[e.lineupSlotId]; })
            .sort(function (a, b) { return ORDER.indexOf(a.lineupSlotId) - ORDER.indexOf(b.lineupSlotId); });
          entries.forEach(function (e) {
            var p = e.playerPoolEntry.player, id = p.id, prev = players[id] || {};
            var proj = ((p.stats || []).filter(function (s) { return s.statSourceId === 1; })[0] || {}).appliedTotal || 0;
            var official = e.playerPoolEntry.appliedStatTotal || 0;
            var row = {
              id: id, side: x[0], name: p.fullName, short: p.defaultPositionId === 16 ? p.fullName : short(p.fullName),
              pos: POS[p.defaultPositionId] || "", slot: SLOTS[e.lineupSlotId], proTeam: p.proTeamId,
              pro: inf.abbrev[p.proTeamId] || "", proj: proj, official: official, injury: p.injuryStatus || "",
              officialAt: prev.official === official && prev.officialAt ? prev.officialAt : Date.now(),
              fast: prev.fast, fastAt: prev.fastAt, shown: prev.shown
            };
            players[id] = row;
            seen[id] = 1;
            lineup[x[0]].push(row);
          });
        });
        Object.keys(players).forEach(function (id) { if (!seen[id]) delete players[id]; });   // a lineup change
        var all = lineup.me.concat(lineup.them);
        var ids = all.map(function (p) { return p.id + p.slot; }).join(",");
        var key = ids + "|" + all.map(function (p) { return p.injury; }).join(",");   // injury news redraws too
        if (key !== lineupKey) {
          var side = function (tid, list) {
            var t = inf.teams[tid] || {};
            return { name: t.name, abbrev: t.abbrev, owner: t.ownerName, logo: t.logo, lineup: list.map(function (p) { return { id: p.id, name: p.name, slot: p.slot, pos: p.pos, pro: p.pro, proTeam: p.proTeam, proj: p.proj, injury: p.injury, kickoff: (games[p.proTeam] || {}).start }; }) };
          };
          var swapped = lineupKey.split("|")[0] !== ids;   // not just injury news
          lineupKey = key;
          O.teams(side(inf.me, lineup.me), side(inf.opp, lineup.them));
          if (swapped) lastShown = null;   // a new lineup: the first look again, no flashes
          if (inf.period !== shownPeriod) { finalSent = false; shownPeriod = inf.period; }
        }
        // the whole league this week, for the league view
        if (window.FantasyLeague) window.FantasyLeague(inf.period, [(inf.teams[inf.me] || {}).name]).then(O.league, function () {});
        if (window.FantasyBench) O.bench(window.FantasyBench(mine), window.FantasyBench(them));   // ESPN Fantasy's points for each bench
        if (window.FantasyRanks && Date.now() - ranksAt > 3600000) {   // opponents' ranks by position: they move once a week
          ranksAt = Date.now();
          window.FantasyRanks().then(O.ranks, function () { ranksAt = 0; });
        }
        O.winProbability(typeof mine.winProbability === "number" ? mine.winProbability : null);
        O.projections(mine.totalProjectedPointsLive, them.totalProjectedPointsLive);   // ESPN's live projected finals
        settle();
      });
    });
  }

  // ESPN's scoreboard: which games are on, and how far along
  function pollBoard() {
    return getJson(SITE + "scoreboard").then(function (d) {
      (d.events || []).forEach(function (ev) {
        var c = ev.competitions[0], st = ev.status || {}, type = (st.type || {}).state || "pre";
        var start = Date.parse(c.date), q = st.period || 0, clock = st.clock || 0;
        var left = type === "post" ? 0 : type === "pre" ? 1 : Math.max(0, Math.min(1, ((4 - q) * 900 + clock) / 3600));
        var wx = ev.weather || (c.weather) || null;   // the forecast, for outdoor games
        var text = type === "post" ? "Final" : ((st.type || {}).shortDetail || "").replace(/ - /, " ");   // "Q3 4:12", "Sun 1:00 PM EST"
        var sit = c.situation || {};   // while a game is on: who has the ball, and whether inside the 20
        c.competitors.forEach(function (t) {
          var o = c.competitors.filter(function (x) { return x !== t; })[0] || { team: {} };
          games[+t.team.id] = { id: ev.id, cid: c.id, state: type, start: start, left: left, text: text,
                                home: t.homeAway === "home", indoor: !!(c.venue || {}).indoor,
                                us: +t.score || 0, them: +o.score || 0, opp: o.team.abbreviation || "",
                                offense: type === "in" && String(sit.possession) === String(t.team.id),
                                redzone: false,   // from the play-by-play instead (publishGames)
                                down: type === "in" && String(sit.possession) === String(t.team.id) ? sit.downDistanceText || "" : "",   // "2nd & 6 at TB 14"
                                weather: wx ? { text: wx.displayValue || "", temp: wx.temperature } : null };
        });
      });
      publishGames();
      O.clock(Date.now());
    });
  }

  // The box score of every live game a starter is in
  var busy = false;
  var fetched = {};   // ESPN game id -> { at: last full summary, count: core play count, plays: its play count, until: wait for a new play }
  function needSummary(gid, g) {
    var f = fetched[gid] || (fetched[gid] = { at: 0, count: -1, plays: -1, until: 0 }), now = Date.now();
    if (!summaries[gid] || now - f.at >= (g.state === "post" ? POST_MS : FULL_MS) || now < f.until) return Promise.resolve(true);
    if (g.state !== "in" || !g.cid) return Promise.resolve(false);
    return getJson(CORE + gid + "/competitions/" + g.cid + "/plays?limit=1").then(function (c) {
      if (c.count === f.count) return false;
      var first = f.count < 0;
      f.count = c.count;
      if (first) return false;       // the first count is just where it stands
      f.until = now + NEW_PLAY_MS;   // fetch until the new play shows up in the summary (it trails the count)
      return true;
    }, function () { return true; });
  }
  function pollGames() {
    if (busy || !info) return Promise.resolve();
    var want = {};
    Object.keys(players).forEach(function (id) {
      var g = games[players[id].proTeam];
      if (g && (g.state === "in" || (g.state === "post" && Date.now() - g.start < 5 * 3600000))) want[g.id] = g;
    });
    var ids = Object.keys(want);
    if (!ids.length) return Promise.resolve();
    busy = true;
    return Promise.all(ids.map(function (gid) {
      return needSummary(gid, want[gid]).then(function (need) {
        if (!need) return;
        return getJson(SITE + "summary?event=" + gid).then(function (raw) {
          var s = slim(raw), f = fetched[gid], n = plays(s).length;
          raw = null;
          f.at = Date.now();
          if (n !== f.plays) { if (f.plays >= 0) f.until = 0; f.plays = n; }   // the new play is in: back to counting
          summaries[gid] = s;
          scanPlays(gid, s);
          var pts = boxPoints(s, info.pts), changed = [], fresh = [];
          Object.keys(players).forEach(function (id) {
            var p = players[id];
            if (p.pos === "D/ST" || pts[id] == null) return;
            if (p.fast !== pts[id]) { if (p.fast != null) fresh.push(+id); p.fast = pts[id]; p.fastAt = Date.now(); changed.push(+id); }
          });
          if (fresh.length) {
            var last = plays(s).slice(-1)[0] || {}, at = stamp(last);
            tlog(fresh.map(function (id) { return players[id].short + " " + players[id].fast; }).join(", ") +
                 (at ? " (ESPN stamped it " + Math.round((Date.now() - at) / 1000) + " s ago)" : "") + " · " + (last.text || "").slice(0, 60));
          }
          settle();
        });
      }).catch(function () {});
    })).then(function () { busy = false; }, function () { busy = false; });
  }

  // Which number each player shows, and a flash for every change
  function value(p) {
    var g = games[p.proTeam] || {};
    if (p.pos === "D/ST" || p.fast == null) return p.official;
    if (p.fast === p.official) return p.fast;
    // the fast feed and ESPN Fantasy disagree: the feed is usually ahead; ESPN Fantasy wins if it holds for 3 minutes
    if (Date.now() - Math.max(p.officialAt || 0, p.fastAt || 0) > TRUST_MS) return p.official;
    if (g.state === "post" && Date.now() - (p.fastAt || 0) > TRUST_MS) return p.official;
    return p.fast;
  }
  function round(v) { return Math.round(v * 100) / 100; }
  function totalsOf(vals) {
    var t = { me: 0, them: 0 };
    Object.keys(players).forEach(function (id) { t[players[id].side] += vals[id] || 0; });
    return { me: round(t.me), them: round(t.them) };
  }
  // Every new play that scores for a starter: its own flash, held until the broadcast shows it (ESPN's stamp
  // on the play plus DELAY). The plays already there the first time a game is looked at are old news.
  function scanPlays(gid, s) {
    var first = !scanned[gid], roster = Roster(s);
    scanned[gid] = 1;
    plays(s).forEach(function (pl) {
      var bySide = {};   // two starters on one side in one play (your QB to your receiver): one card for both
      playPoints(pl, roster, info.pts).forEach(function (h) {
        var k = pl.id + ":" + h.id;
        if (done[k]) return;
        done[k] = 1;
        if (first || !players[h.id] || lastShown === null || players[h.id].pos === "D/ST") return;
        (bySide[players[h.id].side] = bySide[players[h.id].side] || []).push(h);
      });
      Object.keys(bySide).forEach(function (side) {
        var hits = bySide[side].sort(function (a, b) { return b.pts - a.pts; });   // the bigger share leads the card
        var at = stamp(pl) || Date.now();
        var label = describe(hits, pl);
        tlog(label + ", popup in " + Math.max(0, Math.round((at + delayOf(gid) - Date.now()) / 1000)) + " s");
        hits.forEach(function (h) { pending[h.id] = (pending[h.id] || 0) + 1; });
        due.push({ id: nextId++, gid: gid, at: at, label: label, fire: function () {
          hits.forEach(function (h) { pending[h.id]--; });
          flash(hits[0].id, hits[0].pts, hits[0].cap, pl, hits.slice(1));
        } });
      });
    });
  }
  // A play in words, for the phone's sync button: "Josh Allen's 5 yd pass to D. Knox",
  // "Parker Washington's 2 yd TD catch from Trevor Lawrence" (a name in the matchup in full)
  function describe(hits, pl) {
    var h = hits[0], cap = h.cap.replace(/^TD · | · TD$/, ""), td = /TD/.test(h.cap) || hits.some(function (x) { return /TD/.test(x.cap); });
    var what = (td ? cap.replace(/(\S+)$/, "TD $1") : cap).replace(/^[A-Z][a-z]/, function (w) { return w.toLowerCase(); });   // "interception"
    var m = PASS.exec(((pl.text || "").trim()).replace(LEAD, "")), other = "";
    var named = function (init, last) {   // someone else in the matchup on the play: their full name
      var mate = hits.filter(function (x) { return x !== h && players[x.id] && players[x.id].short === init + ". " + last; })[0];
      return mate ? players[mate.id].name : init + ". " + last;
    };
    if (m && / pass$/.test(cap)) other = " to " + named(m[3], m[4]);
    else if (m && / catch$/.test(cap)) other = " from " + named(m[1], m[2]);
    return players[h.id].name + "'s " + what + other;
  }
  // The box score against what the flashes have shown. A team defence has no plays to go by, so it flashes
  // as ESPN Fantasy moves. Anyone else is left to their plays' flashes, and only once the box score has
  // held still long enough for every play to have been written up and shown is a difference settled:
  // quietly if it is small (rounding, a play the text did not explain), with a flash if it is not.
  function settle() {
    var now = {};
    Object.keys(players).forEach(function (id) { now[id] = round(value(players[id])); });
    if (lastShown === null) {   // first look: no flashes, just the numbers
      var t0 = totalsOf(now);
      O.event({ final: false, me: t0.me, them: t0.them, players: now });
      lastShown = now;
      return;
    }
    Object.keys(now).forEach(function (id) {
      var p = players[id], d = round(now[id] - (lastShown[id] || 0));
      if (Math.abs(d) < 0.05 || pending[id]) return;
      if (p.pos === "D/ST") return flash(id, d, "Defense", null);
      if (Date.now() - Math.max(p.fastAt || 0, p.officialAt || 0) < delayOf((games[p.proTeam] || {}).id) + PLAY_WAIT_MS) return;
      if (Math.abs(d) >= 2) return flash(id, d, d >= 6 ? "TD" : d > 0 ? "" : "Stat correction", null);   // a play ESPN never wrote up (seen: a 1 yd TD missing from its play-by-play)
      lastShown[id] = now[id];
      var tq = totalsOf(lastShown), one = {};
      one[id] = now[id];
      O.event({ final: false, me: tq.me, them: tq.them, players: one });
    });
    // the final, once: every starter's game is over and nothing has moved for a while (ESPN Fantasy caught up)
    var ids = Object.keys(players), over = ids.length && ids.every(function (id) { return (games[players[id].proTeam] || {}).state === "post"; });
    var waiting = ids.some(function (id) { return pending[id]; });
    if (over && !finalSent && !waiting && Date.now() - lastChange > FINAL_QUIET_MS) {
      finalSent = true;
      var tf = totalsOf(now);
      O.event({ final: true, me: tf.me, them: tf.them, players: now });
    }
  }
  function flash(id, d, cap, play, chain) {
    var p = players[id];
    if (!p || lastShown === null || Math.abs(d) < 0.05) return;
    var v = round((lastShown[id] || 0) + d);
    lastShown[id] = v;
    var also = (chain || []).filter(function (h) { return players[h.id]; }).map(function (h) {
      var q = players[h.id], w = round((lastShown[h.id] || 0) + h.pts);
      lastShown[h.id] = w;
      return { id: +h.id, name: q.short, pos: q.pos, pts: h.pts, cap: h.cap, player: w };
    });
    var t = totalsOf(lastShown), g = games[p.proTeam], game = null;
    if (play && g) {   // the game's score and clock as of the play, not now
      var h = g.home;
      game = { us: h ? play.homeScore : play.awayScore, them: h ? play.awayScore : play.homeScore, opp: g.opp, q: when(play) };
    } else if (g && g.state !== "pre") game = { us: g.us, them: g.them, opp: g.opp, q: g.text };
    O.event({ side: p.side, id: +id, name: p.short, pos: p.pos, pro: p.pro, pts: d, cap: cap,
              me: t.me, them: t.them, player: v, t: Date.now(), game: game, chain: also });
    lastChange = Date.now();
  }
  function when(play) {
    var n = (play.period || {}).number || 0;
    return ((play.clock || {}).displayValue || "") + " " + (["", "1st", "2nd", "3rd", "4th"][n] || "OT");
  }

  // ---------------- each live game as the broadcast shows it: its play-by-play as of DELAY ago
  var DRIVE_END = /Kickoff|Punt|Extra Point|Two-?Point|End of Half|End of Game|Safety/i;
  function gameView(s, asOf) {
    var comp = ((s.header || {}).competitions || [])[0] || {}, home = "", away = "";
    (comp.competitors || []).forEach(function (c) { if (c.homeAway === "home") home = c.team.id; else away = c.team.id; });
    var all = plays(s), list = all.filter(function (p) { return stamp(p) <= asOf; });
    if (!list.length || !home) return null;
    var rz = null, rzAt = 0, off = null, down = "";
    list.forEach(function (p) {
      var typ = (p.type || {}).text || "", st = p.start || {}, en = p.end || {}, team = String((st.team || {}).id || "");
      if (p.scoringPlay || p.isTurnover || DRIVE_END.test(typ)) {   // the drive is over: no red zone, whatever the yard line
        rz = null; off = String((en.team || {}).id || "") || off; down = ""; return;
      }
      if (!(st.down >= 1)) return;   // a timeout, the end of a quarter
      off = String((en.team || {}).id || "") || team;
      if (off !== team) { rz = null; down = ""; return; }   // turned over on downs
      if (en.yardsToEndzone >= 1 && en.yardsToEndzone <= 20) {   // one trip a drive, even if a penalty
        if (rz !== team) rzAt = stamp(p);
        rz = team;
      }
      else if (rz !== team) rz = null;                                     // pushes them back out for a play
      down = (en.downDistanceText || "").trim();
    });
    var last = list[list.length - 1];
    return { home: home, away: away, rz: rz, rzAt: rzAt, off: off, down: down, homeScore: last.homeScore, awayScore: last.awayScore,
             text: when(last), pending: list.length < all.length };
  }

  // ---------------- tap-to-sync (the phone remote, remote.html, through RemoteService)
  // ESPN's stamps run early or late by a different amount in each game (each has its own person logging
  // plays), so each game keeps its own delay. A tap on the phone at the moment a play happens on screen is
  // matched to the popup shown (or due) nearest to it, within a minute, and moves that game's delay so the
  // popup would have landed on the tap. Kept for the day in this WebView's storage.
  var SYNC_KEY = "fantasy-sync-" + new Date().toDateString(), gameDelay = {}, lastSync = null;
  try { gameDelay = JSON.parse(localStorage.getItem(SYNC_KEY) || "{}") || {}; } catch (e) {}
  function delayOf(gid) { return gid != null && gameDelay[gid] != null ? gameDelay[gid] : DELAY; }
  function saveDelays() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(gameDelay)); } catch (e) {} }
  var due = [], shown = [];   // popups on their way { gid, at (ESPN's stamp), label, fire }, and shown { ..., when }
  var nextId = 1, espn = { ok: null };
  function remember(c, when) { c.id = c.id || nextId++; c.when = when; shown.push(c); if (shown.length > 40) shown.shift(); }
  setInterval(function () {   // each popup the moment its game's delay says the broadcast shows the play
    var now = Date.now();
    due = due.filter(function (d) {
      if (now < d.at + delayOf(d.gid)) return true;
      d.fire();
      remember(d, now);
      return false;
    });
  }, 250);
  function teamAbbr(gid, tid) {
    var comp = (((summaries[gid] || {}).header || {}).competitions || [])[0] || {}, out = "";
    (comp.competitors || []).forEach(function (c) { if (c.team.id === tid) out = c.team.abbreviation; });
    return out;
  }
  function gameName(gid) {
    var comp = (((summaries[gid] || {}).header || {}).competitions || [])[0] || {}, h = "", a = "";
    (comp.competitors || []).forEach(function (c) { if (c.homeAway === "home") h = c.team.abbreviation; else a = c.team.abbreviation; });
    return a && h ? a + " @ " + h : gid;
  }
  function secs(ms) { return Math.round(ms / 1000); }
  // a play's own words, shortened for the phone: "J.Allen pass short right to D.Knox to BUF 44 for 7 yards"
  function playWords(p) {
    return (p.text || "").trim().replace(LEAD, "").replace(/\s*\([^()]*\)\s*\.?\s*$/, "").replace(/\.$/, "").slice(0, 110);
  }
  function findPlay(gid, pid) {
    var s = summaries[gid];
    return s ? plays(s).filter(function (p) { return String(p.id) === String(pid); })[0] : null;
  }
  // The plays (any play, in the games being followed) around a tap, newest first, for "which play was it?"
  function aroundTap(t) {
    var out = [];
    Object.keys(summaries).forEach(function (gid) {
      plays(summaries[gid]).forEach(function (p) {
        var at = stamp(p), st = p.start || {};
        if (at < t - 150000 || at > t + 5000 || !(st.down >= 1 || p.scoringPlay) || /Timeout|spiked|No Play/i.test(p.text || "")) return;
        out.push({ id: "p:" + gid + ":" + p.id, at: at, play: playWords(p), game: gameName(gid) });
      });
    });
    return out.sort(function (a, b) { return b.at - a.at; }).slice(0, 8)
      .map(function (c) { return { id: c.id, play: c.play, game: c.game, before: secs(t - c.at) }; });
  }
  var aim = null, pickTap = 0;   // the play the button names; a tap waiting to be told which play it was
  function setDelay(gid, at, t, label) {
    var before = delayOf(gid), after = Math.max(0, Math.min(180000, t - at));
    lastSync = { gid: gid, had: gameDelay[gid] };
    gameDelay[gid] = after;
    saveDelays();
    tlog("sync " + gameName(gid) + " " + secs(before) + " -> " + secs(after) + " s (" + label + ")");
    return { ok: true, play: label, game: gameName(gid), before: secs(before), after: secs(after) };
  }
  window.FantasySync = {
    // A tap at time t. With id (the play the button named, or one picked from the list): that play's game
    // is synced to the tap. Without: the tap waits for the phone to say which play it was (choose).
    tap: function (t, id) {
      t = t || Date.now();
      if (!id) { pickTap = t; return { ok: true, pick: true }; }
      return this.match(t, id);
    },
    choose: function (id) {
      if (!pickTap) return { ok: false, msg: "Tap the button when a play happens first." };
      var r = this.match(pickTap, id);
      if (r.ok) pickTap = 0;
      return r;
    },
    match: function (t, id) {
      id = String(id);
      if (id.indexOf("p:") === 0) {
        var part = id.split(":"), p = findPlay(part[1], part[2]);
        if (!p) return { ok: false, msg: "That play is gone from ESPN's list. Try another." };
        aim = null;
        return setDelay(part[1], stamp(p) || t, t, playWords(p));
      }
      var c = shown.concat(due).filter(function (x) { return String(x.id) === id; })[0];
      if (!c) return { ok: false, msg: "That play isn't there any more. Tap when any play happens instead." };
      aim = null;
      return setDelay(c.gid, c.at, t, c.label);
    },
    nudge: function (gid, s) {
      gameDelay[gid] = Math.max(0, Math.min(180000, delayOf(gid) + s * 1000));
      saveDelays();
      return this.state();
    },
    undo: function () {
      if (lastSync) { if (lastSync.had == null) delete gameDelay[lastSync.gid]; else gameDelay[lastSync.gid] = lastSync.had; saveDelays(); lastSync = null; }
      return this.state();
    },
    reset: function () { gameDelay = {}; lastSync = null; pickTap = 0; aim = null; saveDelays(); return this.state(); },
    state: function () {
      var now = Date.now();
      var list = Object.keys(summaries).filter(function (gid) {
        var comp = ((summaries[gid].header || {}).competitions || [])[0] || {};
        return ((comp.status || {}).type || {}).state !== "post" || gameDelay[gid] != null;
      }).map(function (gid) { return { gid: gid, name: gameName(gid), delay: secs(delayOf(gid)), synced: gameDelay[gid] != null }; });
      // the button names the next popup coming (it gives the play away, which is fine for a one-time sync),
      // kept until a minute after it shows so it doesn't change while you watch for it
      if (aim && now > aim.until) aim = null;
      if (!aim) {
        var next = due.slice().sort(function (a, b) { return (a.at + delayOf(a.gid)) - (b.at + delayOf(b.gid)); })[0];
        if (next) aim = { id: next.id, gid: next.gid, label: next.label, until: next.at + delayOf(next.gid) + 60000 };
      }
      if (pickTap && now - pickTap > 180000) pickTap = 0;
      var abbr = function (id) { return info && info.teams && info.teams[id] ? info.teams[id].abbrev || info.teams[id].name : ""; };
      var shownTot = lastShown ? totalsOf(lastShown) : null;
      return { def: secs(DELAY), games: list, canUndo: !!lastSync, espn: espn,
               score: info && shownTot ? { me: abbr(info.me), them: abbr(info.opp), a: shownTot.me, b: shownTot.them } : null, look: O.look ? O.look() : null, lineup: O.lineup ? O.lineup() : null, quality: O.quality ? O.quality() : null,
               target: aim ? { id: aim.id, play: aim.label, game: gameName(aim.gid) } : null,
               pick: pickTap ? aroundTap(pickTap) : null,
               recent: shown.slice(-6).reverse().map(function (c) { return { play: c.label, game: gameName(c.gid), ago: secs(now - c.when) }; }) };
    }
  };
  var lastRz = {}, gamesKey = "";
  function publishGames() {
    var byTeam = {};
    Object.keys(games).forEach(function (id) {
      var g = games[id];
      byTeam[id] = { state: g.state, text: g.text, us: g.us, them: g.them, opp: g.opp, home: g.home, start: g.start, indoor: g.indoor, offense: g.offense, redzone: false, down: g.down, weather: g.weather };
    });
    Object.keys(summaries).forEach(function (gid) {
      var v = gameView(summaries[gid], Date.now() - delayOf(gid));
      if (!v) return;
      [v.home, v.away].forEach(function (tid) {
        var b = byTeam[tid];
        if (!b) return;
        if (b.state === "post" && v.pending) b.state = "in";   // over for ESPN, not yet on the broadcast
        if (b.state !== "in") return;
        var h = tid === v.home;
        b.us = h ? v.homeScore : v.awayScore; b.them = h ? v.awayScore : v.homeScore; b.text = v.text;
        b.offense = v.off === tid; b.redzone = v.rz === tid; b.down = b.offense ? v.down : "";
        if (b.redzone && !lastRz[tid]) {
          tlog("red zone " + (games[tid] || {}).opp + " opponent, " + b.down);
          var ours = Object.keys(players).some(function (id) { return String(players[id].proTeam) === tid && players[id].pos !== "D/ST"; });
          if (ours && v.rzAt) remember({ gid: gid, at: v.rzAt, label: teamAbbr(gid, tid) + " reaching the red zone" }, Date.now());
        }
        lastRz[tid] = b.redzone;
      });
    });
    // only when something changed: it runs every second while a game is on, and the overlay redraws for it
    var key = JSON.stringify(byTeam);
    if (key !== gamesKey) { gamesKey = key; O.games(byTeam); }
  }

  function loop(fn, ms) { (function go() { fn().catch(function () {}).then(function () { setTimeout(go, typeof ms === "function" ? ms() : ms); }); })(); }
  pollBoard().catch(function () {}).then(function () {
    loop(function () {   // and whether ESPN Fantasy answers, for the phone page ("No ESPN login on this TV")
      return pollFantasy().then(function () { espn = { ok: true, at: Date.now() }; }, function (e) {
        var m = String((e && e.message) || e);
        espn = { ok: false, at: Date.now(), msg: / 503$/.test(m) ? "No ESPN login on this TV" : / 40[13]$/.test(m) ? "ESPN turned the login down (it may have expired)" : "Can't reach ESPN Fantasy" };
        throw e;
      });
    }, FANTASY_MS);
    var boardAt = Date.now();   // every 15 seconds while a starter's game is on (the plays themselves come from each game's own feed), every 30 otherwise
    loop(function () {
      if (Date.now() - boardAt < (liveNow() ? BOARD_LIVE_MS : BOARD_MS)) return Promise.resolve();
      boardAt = Date.now();
      return pollBoard();
    }, LIVE_MS);
    setInterval(function () { if (liveNow()) publishGames(); }, 1000);   // so a held red zone lands on its second
    loop(pollGames, LIVE_MS);
  });
})();
