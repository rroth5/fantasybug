// fantasybug: your ESPN Fantasy matchup over whatever is playing. A slim scorebug, a card that flashes when a player in
// your matchup scores (with the player's ESPN headshot; green for yours, red for theirs), and a box
// score panel that drops down from the scorebug. The TV app shows this page in a window over the app
// you are watching; nothing here takes the remote's keys.
//
// window.FantasyOverlay:
//   teams(me, them)          { name, abbrev, owner, logo, lineup: [{ id, name, slot, pos, pro }] } for each side
//   event(e)                 { side: "me"|"them", id, name, pos, pro, pts, cap, me, them, player }: a flash.
//                            me/them/player are the exact totals after this play: the scores are set to
//                            them, never added up from flashes, so a flash shown late or skipped can't
//                            leave a score wrong. An event with final: true sets the final and shows no card.
//   score(mine, theirs)      set both totals (the live box score's exact numbers)
//   player(id, points)       set one player's exact points in the box score panel
//   clock(ms)                what time it is in the games (live: now; a replay: the latest play's time)
//   winProbability(p)        ESPN Fantasy's own chance for you (0..1), or null to use the built-in model
//   games(byTeam)            each NFL team's game, { id: { state: "pre"|"in"|"post", text: "Q3 4:12",
//                            offense, redzone } }: offense while the team has the ball, redzone inside the 20
//   cycle()                  the remote's button: scorebug, then box score, then league, then hidden, then scorebug again
//   toggle(on) / box(open)   show or hide the whole overlay / the box score panel
//   league(list) / leagueView(open)   the other matchups this week / show or hide the league view
//   settings                 window.FANTASYBUG.popups: { plays, touchdowns, redzone, lead, final }, each false to
//                            leave that popup out (the scores still move)
// Preview: ?replay=week plays back the made-up sample week in sample-week.json (&speed=2 for twice as fast,
// &standin=1 for a stand-in football picture behind it). Click the scorebug for the box score, the box score for the league; F hides it all.
(function () {
  "use strict";
  var Q = location.search;
  var FLASH_MS = 6000, GAP_MS = 2500, PACE = 1;   // PACE: a replay's speed
  var ov = document.getElementById("ov"), strip = document.getElementById("strip"), flashes = document.getElementById("flashes");
  var panel = document.createElement("div");
  panel.className = "box";
  ov.insertBefore(panel, flashes);
  var gauge = document.createElement("div");
  gauge.className = "wp";
  ov.insertBefore(gauge, strip);
  var teams = { me: {}, them: {} }, score = { me: 0, them: 0 }, points = {}, rows = {};

  // ---------------- the lineup widget: your starters and their points (and your opponent's, if you like) in a
  // compact panel of its own, shown or hidden and placed from the phone: middle left or right, or a corner.
  // It steps aside from the scorebug when they share a corner, and hides while the box score or the league is
  // up, which show it all. &lineup=ml (&both=1) to preview.
  var lw = document.createElement("div"), lwRows = {}, lwHit = {};   // lwHit: player id -> when he scored
  lw.className = "lw";
  var LW_KEY = "fantasy-lineup", LW_POS = ["tl", "ml", "bl", "tr", "mr", "br"];
  var lwSet = { on: false, pos: "ml", both: false };
  try { lwSet = Object.assign(lwSet, JSON.parse(localStorage.getItem(LW_KEY) || "{}")); } catch (e) {}
  (function () {
    var q = /[?&]lineup=(tl|ml|bl|tr|mr|br)/.exec(location.search);
    if (q) lwSet = { on: true, pos: q[1], both: /[?&]both=1/.test(location.search) };
  })();
  function lwDodge() {   // the scorebug in the same corner, or the notch along the top
    var l = window.FantasyOverlay && FantasyOverlay.look ? FantasyOverlay.look() : { look: "pill", pos: "tr" };
    if (l.look === "notch") return lwSet.pos === "tl" || lwSet.pos === "tr";
    return l.pos === lwSet.pos;
  }
  // Built once per lineup (and when shown, or with the opponent added); every change after that only updates
  // the numbers and marks in place, so the second-by-second updates of a live game cost next to nothing
  var lwBuilt = "", lwTot = {};
  function drawLineup() {
    if (!lw.parentNode) document.body.appendChild(lw);
    lw.className = "lw lw-" + lwSet.pos + (lwSet.on ? " on" : "") + (lwSet.both ? " both" : "") + (lwDodge() ? " dodge" : "") +
      (ov.classList.contains("notch") ? " notch" : "");
    if (!lwSet.on) {
      if (lwBuilt) { lw.textContent = ""; lwRows = {}; lwTot = {}; lwBuilt = ""; }
      return;
    }
    var sides = lwSet.both ? ["me", "them"] : ["me"];
    var key = sides.map(function (who) {
      var t = teams[who] || {};
      return (t.lineup || []).map(function (p) { return p.id + p.slot; }).join(",") + "|" + (t.logo || "") + (t.abbrev || t.name || "");
    }).join("/");
    if (key !== lwBuilt) {
      lw.textContent = "";
      lwRows = {}; lwTot = {};
      sides.forEach(function (who) {
        var t = teams[who] || {}, col = el("div", "lw-col lw-" + who), head = el("div", "lw-head");
        head.appendChild(picture("lw-logo", t.logo && logoUrl(t.logo), initials(t.name)));
        head.appendChild(el("b", "lw-name", t.abbrev || t.name || ""));
        lwTot[who] = head.appendChild(el("span", "lw-tot"));
        col.appendChild(head);
        (t.lineup || []).forEach(function (p) {
          var w = p.name.split(" "), r = el("div", "lw-row");
          r.appendChild(el("span", "lw-pos", p.slot === "FLEX" && p.pos ? p.pos : p.slot || p.pos || ""));
          r.appendChild(el("span", "lw-pn", p.pos === "D/ST" ? p.name.replace(/ D\/ST$/, "") : w[0][0] + ". " + w.slice(1).join(" ")));
          lwRows[p.id] = { row: r, pp: r.appendChild(el("span", "lw-pp")), p: p };
          col.appendChild(r);
        });
        lw.appendChild(col);
      });
      lwBuilt = key;
    }
    sides.forEach(function (who) { if (lwTot[who]) lwTot[who].textContent = pts(score[who]); });
    Object.keys(lwRows).forEach(function (id) {
      var x = lwRows[id], p = x.p, g = statusOf(p), live = g.state === "in", on = live && p.pos !== "D/ST";
      var since = Date.now() - (lwHit[p.id] || 0), hit = since < 2400;   // just scored: his row lights up
      if (hit && !x.row.classList.contains("hit")) x.row.style.setProperty("--hit-at", -since + "ms");
      x.row.className = "lw-row" + (live ? " live" : g.state === "post" ? " done" : "") +
        (on && g.redzone ? " redzone" : on && g.offense ? " offense" : "") + (hit ? " hit" : "");
      var v = points[p.id] == null ? "–" : pts(points[p.id]);
      if (x.pp.textContent !== v) x.pp.textContent = v;
    });
  }
  var queue = [], busy = false, now = 0;
  var POPUPS = (window.FANTASYBUG || {}).popups || {};
  function wants(kind) { return POPUPS[kind] !== false; }

  if (/[?&]standin=1/.test(Q)) document.documentElement.classList.add("stand-in");
  if (/[?&]still=1/.test(Q)) document.documentElement.classList.add("still");   // preview: no animations, for screenshots
  // The look, chosen on the phone remote (remote.html) and kept on the TV: "pill" (a floating scorebug) in one of six
  // places, or "notch" (hanging from the top edge like a laptop's notch), anywhere along the top: nx is
  // 0 (left) to 100 (right). &notch=1 (&nx=20) or &pos=bl to preview; window.FANTASYBUG.look
  // "notch" for the first look.
  var LOOK_KEY = "fantasy-look", POSITIONS = ["tl", "tc", "tr", "bl", "bc", "br"];
  function applyLook(look, pos, nx) {
    var el = document.getElementById("ov");
    look = look === "notch" ? "notch" : "pill";
    pos = POSITIONS.indexOf(pos) >= 0 ? pos : "tr";
    nx = Math.max(0, Math.min(100, Math.round(typeof nx === "number" ? nx : 50)));
    el.classList.toggle("notch", look === "notch");
    POSITIONS.forEach(function (p) { el.classList.toggle("pos-" + p, look === "pill" && p === pos); });
    if (currentLook && currentLook.nx !== nx) {   // a slide from the phone: animated, and only then
      el.classList.add("moving");
      clearTimeout(applyLook.t);
      applyLook.t = setTimeout(function () { el.classList.remove("moving"); }, 500);
    }
    el.style.setProperty("--nx", nx);
    return { look: look, pos: pos, nx: nx };
  }
  var savedLook = null;
  try { savedLook = JSON.parse(localStorage.getItem(LOOK_KEY) || "null"); } catch (e) {}
  var firstLook = savedLook || { look: (window.FANTASYBUG || {}).look === "notch" ? "notch" : "pill", pos: "tr" };
  if (/[?&]notch=1/.test(Q)) firstLook = { look: "notch", pos: "tc", nx: +((/[?&]nx=(\d+)/.exec(Q) || [])[1] || 50) };
  var qpos = /[?&]pos=(tl|tc|tr|bl|bc|br)/.exec(Q);
  if (qpos) firstLook = { look: "pill", pos: qpos[1] };
  var currentLook = applyLook(firstLook.look, firstLook.pos, firstLook.nx);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pts(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function initials(name) {
    return (name || "").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map(function (w) { return w[0] || ""; }).join("").slice(0, 2).toUpperCase();
  }
  // Image quality, chosen on the phone for how powerful the TV is: [headshot width, logo size] in px. Medium: the
  // biggest headshot, a popup's, shows at about 100 px on a 1080p TV; logos at 16 to 72 px.
  var QUALITY = { low: [96, 64], med: [128, 96], high: [192, 160] }, quality = "med";
  try { quality = QUALITY[localStorage.getItem("fantasy-quality")] ? localStorage.getItem("fantasy-quality") : "med"; } catch (e) {}
  function logoUrl(u) {   // a fantasy team's logo comes through the app, which shrinks it to the logo size
    return /^https:\/\/mystique-api\.fantasy\.espn\.com\//.test(u) ? "espn/logo?u=" + encodeURIComponent(u) + "&px=" + QUALITY[quality][1] : u;
  }
  // ESPN's public headshots (the same ids as ESPN Fantasy), resized by ESPN; a team defence gets its NFL team's logo
  function photoUrl(p) {
    if (p.pos === "D/ST" || p.id < 0) return p.pro ? teamLogoUrl(p.pro) : "";
    var w = QUALITY[quality][0];
    return "https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/" + p.id + ".png&w=" + w + "&h=" + Math.round(w * 0.725);
  }
  // an NFL team's logo from ESPN's resizer, not the 500 px original (1 MB in memory each, 18 in a box score)
  function teamLogoUrl(abbrev) {
    var px = QUALITY[quality][1];
    return "https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/" + abbrev.toLowerCase() + ".png&w=" + px + "&h=" + px;
  }
  function picture(cls, url, fallback) {
    var box = el("div", cls, fallback);
    if (url) {
      var img = new Image();
      img.alt = "";
      img.decoding = "async";
      img.onload = function () { box.textContent = ""; box.appendChild(img); };
      img.src = url;
    }
    return box;
  }

  // ---------------- the scorebug
  var sMine, sThem, pMine, pThem, stFill;
  function drawStrip() {
    strip.textContent = "";
    sMine = el("div", "st-score mine", pts(score.me));
    sThem = el("div", "st-score them", pts(score.them));
    pMine = el("div", "st-proj");
    pThem = el("div", "st-proj");
    var colMine = el("div", "st-col"), colThem = el("div", "st-col");
    // each team's short name over its score, then the projection under it
    if (teams.me.abbrev) colMine.appendChild(el("div", "st-ab", teams.me.abbrev));
    if (teams.them.abbrev) colThem.appendChild(el("div", "st-ab", teams.them.abbrev));
    colMine.appendChild(sMine); colMine.appendChild(pMine);
    colThem.appendChild(sThem); colThem.appendChild(pThem);
    strip.appendChild(picture("st-logo", teams.me.logo && logoUrl(teams.me.logo), initials(teams.me.name)));
    strip.appendChild(colMine);
    strip.appendChild(colThem);
    strip.appendChild(picture("st-logo", teams.them.logo && logoUrl(teams.them.logo), initials(teams.them.name)));
    var line = el("div", "st-wp");   // the win gauge's line, along the top
    stFill = el("i");
    line.appendChild(stFill);
    strip.appendChild(line);
    setScore(score.me, score.them);
  }

  // ---------------- projections: the actual score stays the big number; where ESPN's projections say it
  // ends up sits under it, smaller and dimmer. A player's: points so far plus his projection for the part of
  // his game still to play. A team's: ESPN Fantasy's own live projection when it gives one, else the sum.
  var espnProj = { me: null, them: null };
  function projOf(p) { return (points[p.id] || 0) + (p.proj || 0) * left(p); }
  function teamProj(who) {
    if (espnProj[who] != null) return espnProj[who];
    return (teams[who].lineup || []).reduce(function (s, p) { return s + projOf(p); }, 0);
  }
  function setProjections() {
    var show = !score.final;
    [["me", pMine], ["them", pThem]].forEach(function (x) {
      var n = pts(teamProj(x[0]));
      if (x[1]) x[1].textContent = show ? n : "final";   // the scorebug: just the number, small, under the score
      var tp = panel.querySelector(".bx-" + x[0] + " .bx-tproj");   // the box score: just the number, dimmer, under the total
      if (tp) tp.textContent = show ? n : "final";
    });
    Object.keys(rows).forEach(function (id) { rowStatus(rows[id]); });
  }

  // ---------------- each player's game: "Sun 1:00 PM", "Q3 4:12", "Final". Live, from ESPN's scoreboard
  // (games(), keyed by NFL team id); in a preview, worked out from the kickoff and the clock.
  var gstat = {};
  function kickText(ms) {
    var d = new Date(ms);
    // always 12 hour ("Sun 1:00 PM"), as ESPN Fantasy writes it, whatever the TV's own clock is set to
    return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  function statusOf(p) {
    if (gstat[p.proTeam] || gstat[p.pro]) return gstat[p.proTeam] || gstat[p.pro];
    if (!p.kickoff || !now) return { state: "pre", text: "" };
    if (now < p.kickoff) return { state: "pre", text: kickText(p.kickoff) };
    var l = left(p);
    if (l <= 0) return { state: "post", text: "Final" };
    return { state: "in", text: "Q" + Math.min(4, Math.floor((1 - l) * 4) + 1) };
  }
  // the game's conditions, as a small icon at the end of its line, the way ESPN Fantasy shows them: a dome
  // for an indoor stadium, else the forecast. Bad weather (storm, snow, rain, wind, fog, freezing) in amber,
  // fair weather (sun, some cloud, cloud) dim.
  var BAD = { storm: 1, snow: 1, rain: 1, wind: 1, fog: 1, cold: 1 };
  function weatherKind(g) {
    if (g.indoor) return "dome";
    var wx = g.weather;
    if (!wx) return "";
    var t = wx.text || "";
    if (/storm|thunder/i.test(t)) return "storm";
    if (/snow|sleet|ice|flurr/i.test(t)) return "snow";
    if (/rain|shower|drizzle/i.test(t)) return "rain";
    if (/wind/i.test(t)) return "wind";
    if (/fog|haze|mist/i.test(t)) return "fog";
    if (wx.temp != null && wx.temp <= 32) return "cold";
    if (/partly|mostly sunny|intermittent/i.test(t)) return "partly";
    if (/cloud|overcast/i.test(t)) return "cloud";
    if (/sun|clear|fair|hot/i.test(t)) return "sun";
    return "";
  }
  var CLOUD = '<path d="M7 14.5h10a3.3 3.3 0 0 0 .3-6.6A5 5 0 0 0 7.6 8.6 3 3 0 0 0 7 14.5z"/>';
  var WX = {
    rain: CLOUD + '<path d="M8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/>',
    snow: CLOUD + '<path d="M8 18.5h.01M12 20h.01M16 18.5h.01M10 21.5h.01M14 21.5h.01"/>',
    storm: CLOUD + '<path d="M13 15.5l-2.5 3.5h3l-2 3.5"/>',
    fog: CLOUD + '<path d="M5 18h14M7 21h10"/>',
    wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 17h7"/>',
    cold: '<path d="M10 4.5a2 2 0 1 1 4 0v9.3a4 4 0 1 1-4 0z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    partly: '<path d="M8 3v1.5M3.2 8H4.7M4.6 4.6l1 1M11.4 4.6l-1 1"/><path d="M5.6 10.4A3 3 0 0 1 10.6 7"/>' + '<path d="M8 19h10a3.3 3.3 0 0 0 .3-6.6A5 5 0 0 0 8.6 13.1 3 3 0 0 0 8 19z"/>',
    cloud: CLOUD,
    // a stadium under a roof
    dome: '<path d="M3 19h18M4.5 19v-3.5a7.5 7.5 0 0 1 15 0V19M9 19v-4.5M15 19v-4.5M12 19v-5.5M4.8 13.5h14.4"/>'
  };
  function wxIcon(kind, g) {
    var wx = g.weather || {};
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "bx-wx " + kind + (BAD[kind] ? " bad" : ""));
    s.innerHTML = '<title>' + (kind === "dome" ? "Indoors" : (wx.text || "") + (wx.temp != null ? " " + wx.temp + "°" : "")) + '</title>' + WX[kind];
    return s;
  }
  function ordinal(n) { var t = n % 100, u = n % 10; return n + (t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"); }
  var oppRanks = null;   // { QB: { TEN: 25, ... }, RB: {...}, ... }: each NFL team's rank against each position
  var INJURY = { OUT: ["OUT", "out"], INJURY_RESERVE: ["IR", "out"], SUSPENSION: ["SUSP", "out"], DOUBTFUL: ["D", "doubt"], QUESTIONABLE: ["Q", "q"] };
  // the line under a name: slot (the flex: its position), the opponent, the game, its conditions. The projection under the
  // points: live while the game is on; once it is over, the one ESPN gave at the start of the week, so
  // the final can be read against it
  function rowStatus(r) {
    var p = r.p, g = statusOf(p);
    // the opponent the way ESPN Fantasy writes it, "@TEN" away and "TEN" at home, then his team's score
    var opp = g.opp ? (g.home === false ? "@" : "") + g.opp : p.pro;
    var when = g.state === "pre" && g.start ? kickText(g.start) : g.text;   // "Sun 1:00 PM", "Q3 4:12", "Final"
    // how the opponent ranks against his position (ESPN Fantasy's points allowed, 1st = fewest): green for an
    // easy matchup, red for a hard one, as ESPN Fantasy colours it. Not once his game is over.
    var rank = g.state !== "post" && g.opp && oppRanks && (oppRanks[p.pos] || {})[g.opp];
    // two lines: "QB · @TEN (25th)", then the game, "21–14 · Q3 4:12" or "Sun 1:00 PM", and its conditions
    r.sub.textContent = (p.slot === "FLEX" && p.pos ? p.pos : p.slot) + " · ";   // the flex shows its position: its place in the order says flex
    r.sub.appendChild(el("span", "bx-opp" + (rank ? (rank >= 23 ? " easy" : rank <= 10 ? " hard" : "") : ""), opp + (rank ? " (" + ordinal(rank) + ")" : "")));
    r.sub2.textContent = [g.state !== "pre" && g.us != null ? g.us + "–" + g.them : "", when].filter(Boolean).join(" · ");
    var kind = g.state !== "post" ? weatherKind(g) : "";
    if (kind) r.sub2.appendChild(wxIcon(kind, g));
    // ESPN Fantasy's injury status, while there is still time to swap him out or he might still play
    var inj = g.state !== "post" ? INJURY[p.injury] : null;
    r.inj.textContent = inj ? inj[0] : "";
    r.inj.className = "bx-inj" + (inj ? " " + inj[1] : "");
    r.row.classList.toggle("out", !!inj && inj[1] === "out" && g.state === "pre");
    // his team has the ball: yellow, or red once inside the opponents' 20 (not for a team defence)
    var on = g.state === "in" && p.pos !== "D/ST";
    r.row.classList.toggle("redzone", on && !!g.redzone);
    r.row.classList.toggle("offense", on && !!g.offense && !g.redzone);
    r.row.classList.toggle("live", g.state === "in");
    r.row.classList.toggle("done", g.state === "post" || !!score.final);
    r.proj.textContent = pts(score.final || g.state === "post" ? p.proj || 0 : projOf(p));
  }
  function setScore(a, b, who) {
    score.me = a; score.them = b;
    if (lwSet.on) drawLineup();
    if (!sMine) return;
    sMine.textContent = pts(a);
    sThem.textContent = pts(b);
    [["me", sMine, a], ["them", sThem, b]].forEach(function (x) {
      var tot = panel.querySelector(".bx-" + x[0] + " .bx-total");
      if (tot) tot.textContent = pts(x[2]);
    });
    // the leading team's column lights up
    var cm = panel.querySelector(".bx-me"), ct = panel.querySelector(".bx-them");
    if (cm) cm.classList.toggle("lead", a > b);
    if (ct) ct.classList.toggle("lead", b > a);
    setGauge();
    setProjections();
    var s = who === "me" ? sMine : who === "them" ? sThem : null;
    if (s) {
      s.classList.add("bump");
      setTimeout(function () { s.classList.remove("bump"); }, 900);
    }
    // the lead changing hands (a tie keeps the old leader): the scorebug pulses in the new leader's colour
    var lead = a > b ? "me" : a < b ? "them" : leader;
    if (leader && lead !== leader && !score.final && wants("lead")) leadChange(lead);
    leader = lead;
  }
  var leader = null;
  function leadChange(lead) {
    var cls = lead === "me" ? "mine" : "them";
    strip.classList.remove("lc-mine", "lc-them");
    void strip.offsetWidth;   // restart the pulse
    strip.classList.add("lc-" + cls);
    var old = strip.querySelector(".st-lead");
    if (old) old.remove();
    var t = el("div", "st-lead " + cls, "Lead change");
    strip.appendChild(t);
    setTimeout(function () { t.remove(); strip.classList.remove("lc-" + cls); }, 3400 / PACE);
  }

  // ---------------- win probability
  // ESPN Fantasy's own number (winProbability in its matchup data) when it gives one, so the gauge matches
  // the ESPN app. It only gives it while a matchup is in progress; otherwise (a replay of a past week, or
  // ESPN leaving it out) this model stands in. Each side's final is its points so far plus what its starters are still projected to add; the spread
  // per player is 4 + 0.25 x projection, plus 8 points per team for how wrong projections run, both
  // fading as games are played. Fitted to one real league's 2026 weeks 1-9 (1,133 starters, 63
  // matchups). Projections there picked winners no better than a coin flip before kickoff, so
  // the gauge starts at 50% and takes the model's word once a quarter of the matchup has been played.
  var GAME_MS = 3.25 * 3600000;
  function left(p) {   // share of this player's game still to play
    if (!p.kickoff || !now) return 1;
    return Math.max(0, Math.min(1, 1 - (now - p.kickoff) / GAME_MS));
  }
  function erf(x) {   // Abramowitz and Stegun 7.1.26, good to 1e-7
    var s = x < 0 ? -1 : 1, t = 1 / (1 + 0.3275911 * Math.abs(x));
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  }
  function winChance() {
    var mu = {}, v = 0, projAll = 0, projLeft = 0;
    ["me", "them"].forEach(function (who) {
      var lineup = teams[who].lineup || [], m = score[who], f = 0, pr = 0;
      lineup.forEach(function (p) {
        var l = left(p), proj = p.proj || 0;
        m += proj * l;
        v += Math.pow(4 + 0.25 * proj, 2) * l;
        f += proj * l; pr += proj;
      });
      var share = pr ? f / pr : 1;
      v += Math.pow(8 * share, 2);
      mu[who] = m; projAll += pr; projLeft += f;
    });
    var p = v > 0 ? 0.5 * (1 + erf((mu.me - mu.them) / Math.sqrt(2 * v))) : mu.me > mu.them ? 1 : mu.me < mu.them ? 0 : 0.5;
    var played = projAll ? 1 - projLeft / projAll : 0;
    return 0.5 + (p - 0.5) * Math.min(1, played * 4);
  }
  var wpFill, wpMine, wpThem, wpTrend, history = [];
  function first(o) { return (o || "").split(" ")[0]; }
  function drawGauge() {
    gauge.textContent = "";
    var top = el("div", "wp-top");
    top.appendChild(el("span", "wp-label", "Win probability"));
    wpTrend = el("span", "wp-trend");
    top.appendChild(wpTrend);
    var line = el("div", "wp-line");
    var bar = el("div", "wp-bar");
    wpFill = el("div", "wp-fill");
    bar.appendChild(wpFill);
    wpMine = el("span", "wp-n mine");
    wpThem = el("span", "wp-n them");
    line.appendChild(el("span", "wp-who mine", first(teams.me.owner)));
    line.appendChild(wpMine);
    line.appendChild(bar);
    line.appendChild(wpThem);
    line.appendChild(el("span", "wp-who them", first(teams.them.owner)));
    gauge.appendChild(top);
    gauge.appendChild(line);
    history = [];
    setGauge();
  }
  var espnChance = null;   // ESPN Fantasy's own matchup win probability, the number its app shows, when it gives one
  function setGauge() {
    if (!wpFill) return;
    var p = Math.round((espnChance != null ? espnChance : winChance()) * 100);
    p = Math.max(1, Math.min(99, p));   // never 0 or 100 while anything is left to play
    if (score.final) p = score.me > score.them ? 100 : score.me < score.them ? 0 : 50;
    wpFill.style.width = p + "%";
    if (stFill) stFill.style.width = p + "%";
    wpMine.textContent = p + "%";
    wpThem.textContent = (100 - p) + "%";
    // which way it moved: against the reading from at least five minutes ago (game time)
    var t = now || Date.now();
    if (!history.length || history[history.length - 1].p !== p) history.push({ t: t, p: p });
    var past = history.filter(function (h) { return t - h.t >= 5 * 60000; }).pop();
    var d = past ? p - past.p : 0;
    wpTrend.textContent = Math.abs(d) >= 1 ? (d > 0 ? "▲ " : "▼ ") + Math.abs(d) + "%" : "";
    wpTrend.className = "wp-trend" + (d > 0 ? " up" : d < 0 ? " down" : "");
  }

  // ---------------- the box score panel
  function drawBox() {
    panel.textContent = "";
    rows = {};
    ["me", "them"].forEach(function (who) {
      var t = teams[who], col = el("div", "bx-col bx-" + who);
      var head = el("div", "bx-head");
      head.appendChild(picture("bx-logo", t.logo && logoUrl(t.logo), initials(t.name)));
      var who2 = el("span", "bx-who");   // the team's name, and its owner under it
      who2.appendChild(el("b", "bx-name", t.name || ""));
      if (t.owner) who2.appendChild(el("small", "bx-owner", t.owner));
      head.appendChild(who2);
      var tot = el("span", "bx-tot");
      tot.appendChild(el("span", "bx-total", pts(score[who])));
      tot.appendChild(el("small", "bx-tproj"));
      head.appendChild(tot);
      col.appendChild(head);
      (t.lineup || []).forEach(function (p, i) {
        var r = el("div", "bx-row");
        r.style.setProperty("--i", i);   // the rows come in one after another
        r.appendChild(picture("bx-photo" + (p.pos === "D/ST" ? " team" : ""), photoUrl(p), ""));
        var n = el("span", "bx-pn");
        var w = p.name.split(" ");
        n.appendChild(document.createTextNode(p.pos === "D/ST" ? p.name : w[0][0] + ". " + w.slice(1).join(" ")));
        if (p.pos !== "D/ST" && p.pro) {   // his NFL team's logo after the name (a defence's photo is already its logo)
          var tl = new Image();
          tl.className = "bx-team";
          tl.alt = "";
          tl.decoding = "async";
          tl.onerror = function () { this.remove(); };
          tl.src = teamLogoUrl(p.pro);
          n.appendChild(tl);
        }
        var inj = el("span", "bx-inj");   // OUT, D or Q until his game is over
        n.appendChild(inj);
        var sub = el("small", "bx-s1"), sub2 = el("small", "bx-s2");   // the matchup, then the game
        n.appendChild(sub);
        n.appendChild(sub2);
        r.appendChild(n);
        var cell = el("span", "bx-val");
        var v = el("span", "bx-pp", points[p.id] == null ? "–" : pts(points[p.id]));
        var pr = el("small", "bx-proj");
        cell.appendChild(v);
        cell.appendChild(pr);
        r.appendChild(cell);
        rows[p.id] = { row: r, val: v, proj: pr, sub: sub, sub2: sub2, inj: inj, p: p };
        col.appendChild(r);
      });
      var bench = el("div", "bx-bench");   // what the bench scored, for the "should have started him" moments
      bench.appendChild(el("span", null, "Bench"));
      bench.appendChild(el("b", "bx-bv"));
      col.appendChild(bench);
      panel.appendChild(col);
    });
    placeGauge();
    setBench();
    setProjections();
    setScore(score.me, score.them);
  }

  // ---------------- each side's bench points, at the foot of its column (none known: hidden)
  var benchPts = { me: null, them: null };
  function setBench() {
    ["me", "them"].forEach(function (who) {
      var b = panel.querySelector(".bx-" + who + " .bx-bench");
      if (!b) return;
      b.hidden = benchPts[who] == null;
      b.querySelector(".bx-bv").textContent = benchPts[who] == null ? "" : pts(benchPts[who]);
    });
  }

  // ---------------- what kind of play it was, as a small icon before the play: run, pass, catch, kick
  function playKind(cap) {
    if (/catch/.test(cap)) return "catch";
    if (/pass/.test(cap)) return "pass";
    if (/run/.test(cap)) return "run";
    if (/field goal|Extra point/.test(cap)) return "kick";
    if (/Interception|Fumble/.test(cap)) return "turnover";
    return "";
  }
  // run and pass are Material Icons (Google, Apache License 2.0): directions_run and sports_football,
  // filled so they read from the couch. Catch, kick and turnover are drawn here.
  var ICONS = {
    run: '<path class="f" d="M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9l1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z"/>',
    pass: '<path class="f" d="M3.02 15.62c-.08 2.42.32 4.34.67 4.69s2.28.76 4.69.67l-5.36-5.36zM13.08 3.28C10.75 3.7 8.29 4.62 6.46 6.46s-2.76 4.29-3.18 6.62l7.63 7.63c2.34-.41 4.79-1.34 6.62-3.18s2.76-4.29 3.18-6.62l-7.63-7.63zM9.9 15.5l-1.4-1.4 5.6-5.6 1.4 1.4-5.6 5.6zm11.08-7.12c.08-2.42-.32-4.34-.67-4.69s-2.28-.76-4.69-.67l5.36 5.36z"/>',
    // a catch: the ball in the middle of a target ring (a receiver is a "target")
    catch: '<circle cx="12" cy="12" r="9.5"/><ellipse class="f" cx="12" cy="12" rx="5.2" ry="3.2" transform="rotate(-35 12 12)"/><path d="M10.7 12.9L13.3 11.1" stroke="#0c0c10" stroke-width="1.3"/>',
    // the uprights
    kick: '<path d="M5 3v8h14V3M12 11v10"/>',
    // a turnover: the ball changing hands
    turnover: '<path d="M4 9h13l-3-3M20 15H7l3 3"/>'
  };
  function icon(kind) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "fl-ico " + kind);
    s.innerHTML = ICONS[kind];
    return s;
  }

  // their touchdown: no party. The screen's edges darken once, slowly, in a dull red, and the card lands with a
  // thud instead of a glow (overlay.css, .fl.them.td)
  function groan() {
    var edge = el("div", "edge gloom");
    document.body.appendChild(edge);
    setTimeout(function () { edge.remove(); }, 2600);
  }
  function celebrate(card, side) {
    var edge = el("div", "edge " + (side === "me" ? "mine" : "them"));
    document.body.appendChild(edge);
    setTimeout(function () { edge.remove(); }, 1800);
    setTimeout(function () {
      var r = card.querySelector(".fl-photo").getBoundingClientRect();
      var burst = el("div", "burst " + (side === "me" ? "mine" : "them"));
      burst.style.left = (r.left + r.width / 2) + "px";
      burst.style.top = (r.top + r.height / 2) + "px";
      for (var i = 0; i < 28; i++) {
        var a = (i / 28) * Math.PI * 2 + Math.random() * 0.3, d = 90 + Math.random() * 110;
        var c = el("i");
        c.style.setProperty("--dx", Math.cos(a) * d + "px");
        c.style.setProperty("--dy", Math.sin(a) * d * 0.7 + 40 + "px");
        c.style.setProperty("--r", (Math.random() * 720 - 360) + "deg");
        c.style.setProperty("--c", ["var(--side-c)", "#fff", "#ffd60a"][i % 3]);
        c.style.animationDelay = Math.random() * 80 + "ms";
        burst.appendChild(c);
      }
      document.body.appendChild(burst);
      setTimeout(function () { burst.remove(); }, 1700);
    }, 260 / PACE);
  }

  // numbers that run up to their value, for the box opening and a flash
  // A number running up to its value. At most 30 updates a second, and none when the shown text would not change:
  // every change re-lays out the panel, and the box score runs twenty of these at once.
  function countUp(node, to, ms, sign) {
    if (document.documentElement.classList.contains("still")) ms = 1;
    var t0 = performance.now(), last = 0;
    (function step(t) {
      var k = Math.min(1, (t - t0) / ms);
      if (k < 1 && t - last < 32) return requestAnimationFrame(step);
      last = t;
      var v = (sign && to > 0 ? "+" : "") + pts(to * (1 - Math.pow(1 - k, 3)));
      if (node.textContent !== v) node.textContent = v;
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  function setPlayer(id, v, flash) {
    points[id] = v;
    if (flash) lwHit[id] = Date.now();
    if (lwSet.on) drawLineup();
    var r = rows[id];
    if (!r) return;
    r.val.textContent = pts(v);
    rowStatus(r);
    if (flash) {
      r.row.classList.remove("hit");
      void r.row.offsetWidth;   // restart the highlight
      r.row.classList.add("hit");
    }
  }
  // either the scorebug (with the gauge over it when the odds move) or the box score (the gauge across its
  // top, the scorebug hidden: the box has all of it)
  function placeGauge() {
    if (ov.classList.contains("boxed")) panel.insertBefore(gauge, panel.firstChild);
    else ov.insertBefore(gauge, strip);
  }
  function box(open) {
    open = open === undefined ? !ov.classList.contains("boxed") : open;
    var was = ov.classList.contains("boxed");
    ov.classList.toggle("boxed", open);
    placeGauge();
    if (was && !open) stripBack();
    if (open) ov.classList.remove("leagued");
    if (open && !was) {   // opening: the totals and every player's points run up as the rows come in
      ["me", "them"].forEach(function (who) {
        var tot = panel.querySelector(".bx-" + who + " .bx-total");
        if (tot) countUp(tot, score[who], 900);
      });
      Object.keys(rows).forEach(function (id) { if (points[id] != null) countUp(rows[id].val, points[id], 700); });
    }
  }

  // ---------------- flashes: one at a time, in order (not while the box score is open: its rows light up instead)
  function next() {
    if (busy || !queue.length) return;
    busy = true;
    var e = queue.shift();
    if (e.kind === "rz" || e.name) console.log("[timing] " + new Date().toTimeString().slice(0, 8) + " popup " + (e.kind === "rz" ? "red zone " + e.g.opp : e.name + " " + (e.cap || "")) + (e.t ? " (waited " + Math.round((Date.now() - e.t) / 1000) + " s in line)" : ""));
    if (e.kind === "rz") {   // a heads-up, not a score: nothing to set
      if (ov.classList.contains("boxed") || !wants("redzone")) { busy = false; next(); return; }   // the box's red rows say it
      return show(redZoneCard(e), FLASH_MS);
    }
    if (e.t) now = e.t;
    if (e.final) score.final = true;
    // players first, so the team's projection (built from them) is current when the scores move
    if (e.players) Object.keys(e.players).forEach(function (id) { setPlayer(+id, e.players[id], false); });
    if (e.id != null && typeof e.player === "number") setPlayer(e.id, e.player, true);
    (e.chain || []).forEach(function (c) { setPlayer(c.id, c.player, true); });
    if (typeof e.me === "number" && typeof e.them === "number") setScore(e.me, e.them, e.final ? null : e.side);
    if (e.final && !e.quiet && wants("final") && !ov.classList.contains("boxed")) return show(finalCard(), Math.max(15000, FLASH_MS));
    // springs in from the right, the headshot pops, the points run up, a light sweeps across; a touchdown
    // also gets a TOUCHDOWN banner, and yours a glow that pulses in green, confetti and a flash at the edges
    var chain = e.chain || [], all = (e.pts || 0) + chain.reduce(function (n, c) { return n + c.pts; }, 0);
    all = Math.round(all * 100) / 100;
    var td = /TD/.test(e.cap) || chain.some(function (c) { return /TD/.test(c.cap); });
    if (e.final || e.id == null || ov.classList.contains("boxed") || !wants(td ? "touchdowns" : "plays")) { busy = false; next(); return; }   // numbers only, no card
    if (chain.length) return duo(e, chain, all, td);
    var card = el("div", "fl " + (e.side === "me" ? "mine" : "them") + (td ? " td" : ""));
    if (td) card.appendChild(el("div", "fl-tag", "Touchdown"));
    card.appendChild(picture("fl-photo" + (e.pos === "D/ST" ? " team" : ""), photoUrl(e), initials(e.name)));
    // the points for this play, and the player's total today under it
    var ptsCol = el("div", "fl-score");
    var ptsEl = el("div", "fl-pts" + (all < 0 ? " neg" : ""), (all > 0 ? "+" : "") + pts(all));
    ptsCol.appendChild(ptsEl);
    if (typeof e.player === "number") ptsCol.appendChild(el("div", "fl-tot", pts(e.player) + " total"));
    card.appendChild(ptsCol);
    var t = el("div", "fl-t");
    var b = el("b", null, e.name);
    if (e.pos) b.appendChild(el("span", null, e.pos));
    t.appendChild(b);
    var line = el("small");
    var kind = playKind(e.cap || "");
    if (kind) line.appendChild(icon(kind));
    line.appendChild(document.createTextNode(td ? (e.cap || "").replace(/^TD · | · TD$/, "") : e.cap || ""));   // the banner already says TD
    t.appendChild(line);
    if (e.game) t.appendChild(el("div", "fl-game", e.pro + " " + e.game.us + "–" + e.game.them + " " + e.game.opp + (e.game.q ? " · " + e.game.q : "")));
    card.appendChild(t);
    flashes.appendChild(card);
    if (all > 0) setTimeout(function () { countUp(ptsEl, all, 650, true); }, 180 / PACE);
    if (td && e.side === "me") celebrate(card, e.side);
    else if (td) groan();
    show(card, FLASH_MS, true);
  }
  // Two players on one side in one play (your QB to your receiver): a taller card, a row for each with their
  // headshot, their part of the play and their points, and the two together at the foot
  function duo(e, chain, all, td) {
    var card = el("div", "fl duo " + (e.side === "me" ? "mine" : "them") + (td ? " td" : ""));
    if (td) card.appendChild(el("div", "fl-tag", "Touchdown"));
    [e].concat(chain).forEach(function (p) {
      var row = el("div", "duo-row");
      row.appendChild(picture("fl-photo", photoUrl({ id: p.id, pos: p.pos, pro: e.pro }), initials(p.name)));
      var t = el("div", "fl-t"), b = el("b", null, p.name);
      if (p.pos) b.appendChild(el("span", null, p.pos));
      t.appendChild(b);
      var line = el("small"), kind = playKind(p.cap || "");
      if (kind) line.appendChild(icon(kind));
      line.appendChild(document.createTextNode((p.cap || "").replace(/^TD · | · TD$/, "") + (typeof p.player === "number" ? " · " + pts(p.player) + " total" : "")));
      t.appendChild(line);
      row.appendChild(t);
      row.appendChild(el("div", "duo-pts" + (p.pts < 0 ? " neg" : ""), (p.pts > 0 ? "+" : "") + pts(p.pts)));
      card.appendChild(row);
    });
    var foot = el("div", "duo-foot");
    var sum = el("div", "fl-pts" + (all < 0 ? " neg" : ""), (all > 0 ? "+" : "") + pts(all));
    foot.appendChild(sum);
    foot.appendChild(el("div", "fl-tot", "combined"));
    if (e.game) foot.appendChild(el("div", "fl-game", e.pro + " " + e.game.us + "–" + e.game.them + " " + e.game.opp + (e.game.q ? " · " + e.game.q : "")));
    card.appendChild(foot);
    flashes.appendChild(card);
    if (all > 0) setTimeout(function () { countUp(sum, all, 650, true); }, 180 / PACE);
    if (td && e.side === "me") celebrate(card, e.side);
    else if (td) groan();
    show(card, FLASH_MS + 1500, true);   // two players to read: a little longer
  }
  // a card on screen for its time (shorter while more are waiting), then the next one
  function show(card, ms, appended) {
    if (!appended) flashes.appendChild(card);
    var hold = (queue.length ? Math.max(1800, Math.min(ms, FLASH_MS) - queue.length * 800) : ms) / PACE;
    setTimeout(function () {
      card.classList.add("out");
      setTimeout(function () { card.remove(); busy = false; next(); }, 380 / PACE);
    }, hold);
  }
  function shortName(p) {
    var w = p.name.split(" ");
    return p.pos === "D/ST" ? p.name : w[0][0] + ". " + w.slice(1).join(" ");
  }

  // ---------------- a heads-up when a starter's team gets inside the 20: who, and where the ball is
  // A red zone heads-up: whose players are on the drive (headshots side by side), where the ball is ("1st &
  // 10 at TEN 15") with a little strip of the last 20 yards showing how close, and the game
  function redZoneCard(e) {
    var sides = {};
    e.who.forEach(function (x) { sides[x.side] = 1; });
    var cls = sides.me && sides.them ? "both" : sides.me ? "mine" : "them";
    var card = el("div", "fl rz " + cls), g = e.g, p = e.who[0].p;
    card.appendChild(el("div", "fl-tag", "Red zone"));
    var faces = el("div", "rz-faces" + (e.who.length > 1 ? " two" : ""));
    e.who.slice(0, 2).forEach(function (x) { faces.appendChild(picture("fl-photo " + x.side, photoUrl(x.p), initials(x.p.name))); });
    card.appendChild(faces);
    var t = el("div", "fl-t");
    t.appendChild(el("b", null, g.down || p.pro + " inside the 20"));
    t.appendChild(el("small", "rz-who", e.who.slice(0, 3).map(function (x) { return shortName(x.p); }).join(" · ") + (e.who.length > 3 ? " +" + (e.who.length - 3) : "")));
    var yd = /(\d+)\s*$/.exec(g.down || ""), to = yd ? Math.max(1, Math.min(20, +yd[1])) : null;
    if (to) {   // the ball's spot in the last 20 yards, the end zone at the right
      var bar = el("div", "rz-bar"), ball = el("i");
      ball.style.left = (100 - to * 5) + "%";
      bar.appendChild(ball);
      t.appendChild(bar);
    }
    t.appendChild(el("div", "fl-game", p.pro + " " + g.us + "–" + g.them + " " + g.opp + (g.text ? " · " + g.text : "")));
    card.appendChild(t);
    return card;
  }
  function redZoneAlerts(before) {
    if (!Object.keys(before).length) return;   // the first look: only changes from here on
    Object.keys(gstat).forEach(function (k) {
      var g = gstat[k];
      if (g.state !== "in" || !g.redzone || (before[k] && before[k].redzone)) return;
      var who = [];
      ["me", "them"].forEach(function (side) {
        (teams[side].lineup || []).forEach(function (p) {
          if (p.pos !== "D/ST" && (String(p.proTeam) === k || p.pro === k)) who.push({ side: side, p: p });
        });
      });
      if (who.length) queue.push({ kind: "rz", who: who, g: g });
    });
    next();
  }

  // ---------------- the final: who won, the score, and each side's top scorer
  function finalCard() {
    var me = score.me, them = score.them;
    var res = me > them ? "mine" : me < them ? "them" : "tie";
    var card = el("div", "fl final " + res);
    card.appendChild(el("div", "fl-tag", "Final"));
    var head = el("div", "fn-head");
    head.appendChild(el("b", null, res === "mine" ? "You won" : res === "them" ? "You lost" : "A tie"));
    head.appendChild(el("span", "fn-score", pts(me) + " – " + pts(them)));
    card.appendChild(head);
    var tops = el("div", "fn-tops");
    ["me", "them"].forEach(function (who) {
      var best = (teams[who].lineup || []).reduce(function (b, p) { return !b || (points[p.id] || 0) > (points[b.id] || 0) ? p : b; }, null);
      if (!best) return;
      var chip = el("div", "fn-top " + (who === "me" ? "mine" : "them"));
      chip.appendChild(picture("bx-photo" + (best.pos === "D/ST" ? " team" : ""), photoUrl(best), ""));
      var n = el("span", "fn-n");
      n.appendChild(el("small", null, who === "me" ? "Your top scorer" : first(teams.them.owner) + "'s top scorer"));
      n.appendChild(document.createTextNode(shortName(best)));
      chip.appendChild(n);
      chip.appendChild(el("b", null, pts(points[best.id] || 0)));
      tops.appendChild(chip);
    });
    card.appendChild(tops);
    return card;
  }

  // ---------------- the league, its own view in the remote's cycle (after the box score): every matchup this
  // week, yours first, with logos, short names, owners, records, scores, projections and win chances
  var board = el("div", "lg"), league = [];
  ov.insertBefore(board, flashes);
  function drawLeague() {
    board.textContent = "";
    var head = el("div", "lg-head");
    head.appendChild(el("span", "lg-title", "League"));
    var live = Object.keys(gstat).some(function (k) { return gstat[k].state === "in"; });
    if (live) head.appendChild(el("span", "lg-live", "Live"));
    board.appendChild(head);
    if (!league.length) { board.appendChild(el("div", "lg-none", "No matchups yet")); return; }
    league.forEach(function (m, i) {
      var pa = m.pa, pb = m.pb, ja = m.a.proj, jb = m.b.proj, wa = m.a.win;
      // yours, with this overlay's own numbers (ahead of ESPN Fantasy's), whichever side ESPN put you on
      var meA = m.a.name === teams.me.name, meB = m.b.name === teams.me.name;
      var ours = m.mine && (meA ? m.b.name : m.a.name) === teams.them.name;
      if (ours) {
        var chance = score.final ? (score.me > score.them ? 1 : score.me < score.them ? 0 : 0.5) : (espnChance != null ? espnChance : winChance());
        pa = meA ? score.me : score.them; pb = meA ? score.them : score.me;
        ja = teamProj(meA ? "me" : "them"); jb = teamProj(meA ? "them" : "me");
        wa = chance == null ? null : meA ? chance : 1 - chance;
      }
      var row = el("div", "lg-row" + (m.mine ? " mine" + (meB ? " me-right" : "") : ""));   // me-right: your colour on the bar's right
      row.style.setProperty("--i", i);
      var line = el("div", "lg-line");
      [[m.a, pa, pa > pb, ja], [m.b, pb, pb > pa, jb]].forEach(function (x, j) {
        var side = el("div", "lg-side" + (j ? " right" : "") + (x[2] ? " lead" : ""));
        var who = el("span", "lg-who");
        who.appendChild(el("b", null, x[0].abbrev || x[0].name));   // the team's short name, to keep the view narrow
        var sub = [m.mine && (j ? meB : meA) ? "You" : x[0].owner, x[0].record].filter(Boolean).join(" · ");   // "Sam · 6-3"
        if (sub) who.appendChild(el("small", null, sub));
        var num = el("span", "lg-num");
        num.appendChild(el("span", "lg-pts", pts(x[1])));
        if (x[3] != null && !m.done && !(ours && score.final)) num.appendChild(el("small", "lg-proj", pts(x[3])));   // the projected final, dimmer
        var parts = [picture("lg-logo", x[0].logo && logoUrl(x[0].logo), initials(x[0].name)), who, num];
        (j ? parts.reverse() : parts).forEach(function (c) { side.appendChild(c); });
        line.appendChild(side);
      });
      row.appendChild(line);
      if (wa != null && !m.done) {   // the win chance: a thin bar under the pair, the percentages at its ends
        var w = Math.max(1, Math.min(99, Math.round(wa * 100)));
        var wp = el("div", "lg-wp");
        wp.appendChild(el("span", "lg-wn" + (w > 50 ? " fav" : ""), w + "%"));
        // two parts, each side's share; the favourite's lit, the underdog's dim (an even game: both dim)
        var bar = el("div", "lg-bar"), left = el("i", w > 50 ? "fav" : ""), right = el("i", w < 50 ? "fav" : "");
        left.style.width = w + "%";
        bar.appendChild(left);
        bar.appendChild(right);
        wp.appendChild(bar);
        wp.appendChild(el("span", "lg-wn" + (w < 50 ? " fav" : ""), (100 - w) + "%"));
        row.appendChild(wp);
      }
      board.appendChild(row);
    });
  }
  function leagueView(open) {
    open = open === undefined ? !ov.classList.contains("leagued") : open;
    if (open) { box(false); drawLeague(); }
    ov.classList.toggle("leagued", open);
    stripBack();
  }
  // the scorebug comes back the way the box score and league go out: grown out of the notch
  function stripBack() {
    if (ov.classList.contains("boxed") || ov.classList.contains("leagued")) return;
    strip.classList.remove("back");
    void strip.offsetWidth;   // restart it
    strip.classList.add("back");
  }
  strip.addEventListener("animationend", function (e) { if (e.animationName === "notch-grow") strip.classList.remove("back"); });

  function toggle(on) { ov.classList.toggle("off", on === undefined ? !ov.classList.contains("off") : !on); }

  window.FantasyOverlay = {
    teams: function (me, them) { teams.me = me; teams.them = them; drawGauge(); drawStrip(); drawBox(); drawLineup(); ov.classList.remove("loading"); },
    // the lineup widget from the phone: { on, pos: "tl" | "ml" | "bl" | "tr" | "mr" | "br", both }; none, as it is
    lineup: function (o) {
      if (o) {
        if (typeof o.on === "boolean") lwSet.on = o.on;
        if (LW_POS.indexOf(o.pos) >= 0) lwSet.pos = o.pos;
        if (typeof o.both === "boolean") lwSet.both = o.both;
        try { localStorage.setItem(LW_KEY, JSON.stringify(lwSet)); } catch (e) {}
        drawLineup();
      }
      return { on: lwSet.on, pos: lwSet.pos, both: lwSet.both };
    },
    score: function (a, b, final) { score.final = !!final; setScore(a, b); },
    clock: function (ms) { now = ms; setGauge(); setProjections(); },
    games: function (byTeam) { var before = gstat; gstat = byTeam || {}; setProjections(); redZoneAlerts(before); if (lwSet.on) drawLineup(); },   // { NFL team id: { state, text, us, them, opp, offense, redzone, down } }
    // every matchup this week, for the league view: [{ a: { name, abbrev, logo, owner, record, proj, win }, b: {...}, pa, pb, done, mine }]
    league: function (list) { league = list || []; if (ov.classList.contains("leagued")) drawLeague(); },
    leagueView: leagueView,
    ranks: function (r) { oppRanks = r || null; setProjections(); },
    bench: function (me, them) { benchPts.me = typeof me === "number" ? me : null; benchPts.them = typeof them === "number" ? them : null; setBench(); },
    projections: function (me, them) { espnProj.me = typeof me === "number" ? me : null; espnProj.them = typeof them === "number" ? them : null; setProjections(); },
    winProbability: function (p) { espnChance = typeof p === "number" ? p : null; setGauge(); },
    player: function (id, v) { setPlayer(id, v, false); },
    event: function (e) { queue.push(e); next(); },
    toggle: toggle,
    box: box,
    // image quality from the phone: "low", "med" or "high"; none, as it is. Redraws what shows pictures.
    quality: function (q) {
      if (QUALITY[q] && q !== quality) {
        quality = q;
        try { localStorage.setItem("fantasy-quality", q); } catch (e) {}
        drawStrip(); drawBox(); lwBuilt = ""; drawLineup();
        if (ov.classList.contains("leagued")) drawLeague();
      }
      return quality;
    },
    look: function (look, pos, nx) {   // with no arguments, the look it has
      if (look) {
        currentLook = applyLook(look, pos || currentLook.pos, typeof nx === "number" ? nx : currentLook.nx);
        setTimeout(drawLineup, 0);
        try { localStorage.setItem(LOOK_KEY, JSON.stringify(currentLook)); } catch (e) {}
      }
      return currentLook;
    },
    state: function () { return ov.classList.contains("off") ? "off" : ov.classList.contains("boxed") ? "box" : ov.classList.contains("leagued") ? "league" : "bug"; },
    // the remote's button: scorebug, box score, league, hidden, and round again
    cycle: function () {
      if (ov.classList.contains("off")) { toggle(true); box(false); leagueView(false); }
      else if (ov.classList.contains("boxed")) leagueView(true);
      else if (ov.classList.contains("leagued")) { leagueView(false); toggle(false); }
      else box(true);
    }
  };

  strip.addEventListener("click", function () { box(true); });
  panel.addEventListener("click", function () { leagueView(true); });
  board.addEventListener("click", function () { leagueView(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "f" || e.key === "F") toggle();
    if (e.key === "b" || e.key === "B" || e.key === "Enter") box();
    if (e.key === "l" || e.key === "L") leagueView();
  });

  // ---------------- preview: every NFL game's score and quarter at a moment, from the replay's score lines,
  // keyed by team abbreviation (live, the scoreboard gives these by team id)
  // home stadiums with a roof, fixed or closed for games (live, ESPN's scoreboard says which games are indoors)
  var DOMES = { ARI: 1, ATL: 1, DAL: 1, DET: 1, HOU: 1, IND: 1, LV: 1, LAR: 1, LAC: 1, MIN: 1, NO: 1 };
  function gamesAt(list, t) {
    var out = {};
    list.forEach(function (g) {
      var pt = g.line.filter(function (x) { return x[0] <= t; }).pop(), last = g.line[g.line.length - 1];
      var st;
      if (!pt) st = { state: "pre", text: kickText(g.start) };
      else if (pt === last && t - pt[0] > 20 * 60000) st = { state: "post", text: "Final" };
      else st = { state: "in", text: (pt[3] <= 4 ? "Q" + pt[3] : "OT") + " " + pt[4] };
      var h = pt ? pt[1] : 0, a = pt ? pt[2] : 0;
      var indoor = !!DOMES[g.home];
      out[g.home] = { state: st.state, text: st.text, us: h, them: a, opp: g.away, home: true, start: g.start, indoor: indoor };
      out[g.away] = { state: st.state, text: st.text, us: a, them: h, opp: g.home, home: false, start: g.start, indoor: indoor };
    });
    return out;
  }

  // ---------------- every matchup in the league for one week, from ESPN Fantasy (through whatever serves this
  // page, which adds the login cookies), as league() takes them: scores, live projections, ESPN's win chances
  // and each team's record. The one with a team named in mine is marked and comes first.
  function leagueFor(week, mine) {
    var filter = { schedule: { filterMatchupPeriodIds: { value: [week] } } };
    return fetch("espn/league?view=mTeam&view=mMatchupScore", { cache: "no-store", headers: { "X-Fantasy-Filter": JSON.stringify(filter) } })
      .then(function (r) { if (!r.ok) throw new Error("league " + r.status); return r.json(); })
      .then(function (d) {
        var byId = {}, members = {};
        (d.teams || []).forEach(function (t) { byId[t.id] = t; });
        (d.members || []).forEach(function (m) { members[m.id] = m; });
        var owner = function (t) {   // the owner's first name, under the team's
          var m = members[t.primaryOwner || (t.owners || [])[0]] || {};
          return (m.firstName || m.displayName || "").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        };
        var record = function (t) {
          var o = (t.record || {}).overall;
          return o ? o.wins + "-" + o.losses + (o.ties ? "-" + o.ties : "") : "";
        };
        var side = function (s) {
          var t = byId[s.teamId] || {};
          return { name: t.name || "", abbrev: t.abbrev || "", logo: t.logo || "", owner: owner(t), record: record(t),
                   proj: typeof s.totalProjectedPointsLive === "number" ? s.totalProjectedPointsLive : null,
                   win: typeof s.winProbability === "number" ? s.winProbability : null };
        };
        var score = function (s) { return typeof s.totalPointsLive === "number" ? s.totalPointsLive : s.totalPoints || 0; };
        return (d.schedule || []).filter(function (g) { return g.matchupPeriodId === week && g.home && g.away; }).map(function (g) {
          var m = { a: side(g.home), b: side(g.away), pa: score(g.home), pb: score(g.away), done: g.winner && g.winner !== "UNDECIDED" };
          m.mine = (mine || []).indexOf(m.a.name) >= 0 || (mine || []).indexOf(m.b.name) >= 0;
          if ((mine || []).indexOf(m.b.name) >= 0) m = { a: m.b, b: m.a, pa: m.pb, pb: m.pa, done: m.done, mine: true };   // you on the left, as on the scorebug
          return m;
        }).sort(function (x, y) { return (y.mine ? 1 : 0) - (x.mine ? 1 : 0); });
      });
  }
  window.FantasyLeague = leagueFor;
  // each side's bench points (lineup slot 20; injured reserve left out) from one matchup's rosters, as bench() takes them
  function benchOf(side) {
    return ((side.rosterForCurrentScoringPeriod || side.rosterForMatchupPeriod || {}).entries || [])
      .filter(function (e) { return e.lineupSlotId === 20; })
      .reduce(function (s, e) { return s + ((e.playerPoolEntry || {}).appliedStatTotal || 0); }, 0);
  }
  window.FantasyBench = benchOf;
  // ESPN Fantasy's ranks of every NFL team against each position (points allowed this season), as ranks() takes
  // them. ESPN's own team ids, which do not change.
  var PRO = { 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND",
              12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI",
              23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };
  var POSID = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
  function ranksFor() {
    return fetch("espn/league?view=mPositionalRatings", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("ranks " + r.status); return r.json(); })
      .then(function (d) {
        var out = {}, pr = (d.positionAgainstOpponent || {}).positionalRatings || {};
        Object.keys(pr).forEach(function (pid) {
          var pos = POSID[pid], by = pr[pid].ratingsByOpponent || {};
          if (!pos) return;
          out[pos] = {};
          Object.keys(by).forEach(function (tid) { if (PRO[tid]) out[pos][PRO[tid]] = by[tid].rank; });
        });
        return out;
      });
  }
  window.FantasyRanks = ranksFor;

  // ---------------- preview: a finished week's replay file, with both teams' short names from ESPN Fantasy (the
  // file keeps none; without the league, the scorebug just goes without them)
  function loadReplay(name) {
    return fetch("sample-" + name + ".json").then(function (r) { return r.json(); }).then(function (d) {
      return fetch("espn/league?view=mTeam", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (lg) {
        (lg.teams || []).forEach(function (t) { [d.me, d.them].forEach(function (x) { if (x.name === t.name) x.abbrev = t.abbrev; }); });
        return d;
      }, function () { return d; });
    });
  }

  // ---------------- preview: a still of a finished week, part way through (?snapshot=week&at=110&box=1),
  // for working on the look: the totals after the first "at" plays, the clock at that play. Samples to see the
  // rest: &weather=1, &redzone=1 (rows), &rzflash=1 (the heads-up), &injury=1, &lead=1, &final=1, &league=1, &bench=1, &ranks=1, &demo=1 (every popup in turn)
  var sn = /[?&]snapshot=([\w-]+)/.exec(Q);
  if (sn) {
    var at = parseInt((/[?&]at=(\d+)/.exec(Q) || [])[1], 10) || 110;
    loadReplay(sn[1]).then(function (d) {
      window.FantasyOverlay.teams(d.me, d.them);
      // an earlier moment first, so the win gauge has somewhere to have moved from
      [Math.max(1, at - 25), at].forEach(function (n) {
        var tot = { me: 0, them: 0 }, per = {}, evs = d.events.slice(0, n);
        evs.forEach(function (e) { tot[e.side] += e.pts; per[e.id] = (per[e.id] || 0) + e.pts; });
        now = evs[evs.length - 1].t;
        gstat = gamesAt(d.games || [], now);
        if (/[?&]weather=1/.test(Q)) {   // sample forecasts (finished games keep none) to see the weather flag
          if (gstat.CHI) gstat.CHI.weather = { text: "Showers", temp: 46 };
          if (gstat.BUF) gstat.BUF.weather = { text: "Snow", temp: 28 };
          var fair = [{ text: "Sunny", temp: 64 }, { text: "Partly sunny", temp: 58 }, { text: "Cloudy", temp: 51 }], i = 0;
          Object.keys(gstat).forEach(function (k) {   // the other outdoor games: fair weather, the same for both teams
            var g = gstat[k], o = gstat[g.opp];
            if (g.indoor || g.weather) return;
            g.weather = fair[i++ % fair.length];
            if (o && !o.weather) o.weather = g.weather;
          });
        }
        if (/[?&]redzone=1/.test(Q)) {   // samples (the replay keeps no field position): the first live starter's team
          // in the red zone, and the next one in another game on offense
          var live = d.me.lineup.concat(d.them.lineup).filter(function (p) { return gstat[p.pro] && gstat[p.pro].state === "in"; });
          if (live[0]) gstat[live[0].pro].offense = gstat[live[0].pro].redzone = true;
          var off = live.filter(function (p) { return gstat[p.pro].opp !== live[0].pro && p.pro !== live[0].pro; })[0];
          if (off) gstat[off.pro].offense = true;
        }
        window.FantasyOverlay.event({ me: tot.me, them: tot.them, players: per, t: now });
      });
      var evs = d.events.slice(0, at);
      var starters = d.me.lineup.concat(d.them.lineup);
      if (/[?&]injury=1/.test(Q)) {   // sample injury news (the replay keeps none): on players whose games haven't started
        var pre = starters.filter(function (p) { return p.pos !== "D/ST" && (!gstat[p.pro] || gstat[p.pro].state === "pre"); });
        ["OUT", "QUESTIONABLE", "DOUBTFUL"].forEach(function (s, i) { if (pre[i]) pre[i].injury = s; });
        setProjections();
      }
      if (/[?&]rzflash=1/.test(Q)) {   // the red zone heads-up, for the first live starter's team, held on screen
        var rzp = starters.filter(function (p) { return p.pos !== "D/ST" && gstat[p.pro] && gstat[p.pro].state === "in"; })[0];
        if (rzp) {
          var nextG = JSON.parse(JSON.stringify(gstat));
          nextG[rzp.pro].offense = nextG[rzp.pro].redzone = true;
          nextG[rzp.pro].down = "2nd & 6 at " + nextG[rzp.pro].opp + " 14";
          setTimeout(function () { FLASH_MS = 1e9; window.FantasyOverlay.games(nextG); }, 100);
        }
      }
      if (/[?&]lead=1/.test(Q)) setTimeout(function () {   // the other side goes ahead
        var l = score.me >= score.them ? "them" : "me";
        window.FantasyOverlay.event(l === "them" ? { me: score.me, them: score.me + 2.4 } : { me: score.them + 2.4, them: score.them });
      }, 600);
      if (/[?&]final=1/.test(Q)) setTimeout(function () {   // ESPN Fantasy's official final, and its card
        var official = {};
        starters.forEach(function (p) { official[p.id] = p.official; });
        FLASH_MS = 1e9;
        window.FantasyOverlay.event({ final: true, me: d.me.official, them: d.them.official, players: official });
      }, 100);
      var lweek = +((/[?&]lweek=(\d+)/.exec(Q) || [])[1]) || d.week;   // &lweek=10: another week's league (this week's is live)
      if (/[?&]league=1/.test(Q)) leagueFor(lweek, [d.me.name]).then(function (l) {   // &league=1: the league view open
        window.FantasyOverlay.league(l);
        leagueView(true);
      });
      if (/[?&]ranks=1/.test(Q)) ranksFor().then(window.FantasyOverlay.ranks);   // this week's ranks, not week 9's
      if (/[?&]bench=1/.test(Q)) {   // that week's bench points, from ESPN Fantasy (the whole week's, not at the "at" moment)
        var bf = { schedule: { filterMatchupPeriodIds: { value: [d.week] } } };
        fetch("espn/league?view=mTeam&view=mBoxscore&scoringPeriodId=" + d.week, { cache: "no-store", headers: { "X-Fantasy-Filter": JSON.stringify(bf) } })
          .then(function (r) { return r.json(); }).then(function (lg) {
            var name = {};
            (lg.teams || []).forEach(function (t) { name[t.id] = t.name; });
            (lg.schedule || []).forEach(function (g) {
              if (!g.home || !g.away || g.matchupPeriodId !== d.week) return;
              var h = name[g.home.teamId], a = name[g.away.teamId];
              if (h === d.me.name && a === d.them.name) window.FantasyOverlay.bench(benchOf(g.home), benchOf(g.away));
              if (a === d.me.name && h === d.them.name) window.FantasyOverlay.bench(benchOf(g.away), benchOf(g.home));
            });
          });
      }
      if (/[?&]box=1/.test(Q)) setTimeout(function () { box(true); }, 50);
      if (/[?&]demo=1/.test(Q)) {   // every popup in turn, round and round, for testing: a catch, your touchdown,
        // theirs, a red zone heads-up, a lead change and the final card (shown only, so the matchup is not marked over)
        var catchEv = d.events.filter(function (e) { return /catch/.test(e.cap) && !/TD/.test(e.cap) && e.side === "me"; })[0];
        var tdEv = d.events.filter(function (e) { return /TD/.test(e.cap) && e.side === "me"; })[0];
        var theirTd = d.events.filter(function (e) { return /TD/.test(e.cap) && e.side === "them"; })[0];
        var total = function (e) { return d.events.reduce(function (s, x) { return x.id === e.id ? s + x.pts : s; }, 0); };
        var rzp = starters.filter(function (p) { return p.pos !== "D/ST" && gstat[p.pro] && gstat[p.pro].state === "in"; })[0];
        var steps = [
          function () { var e = Object.assign({}, catchEv); e.player = total(catchEv); delete e.t; window.FantasyOverlay.event(e); },
          function () { var e = Object.assign({}, tdEv); e.player = total(tdEv); delete e.t; window.FantasyOverlay.event(e); },
          function () { var e = Object.assign({}, theirTd); e.player = total(theirTd); delete e.t; window.FantasyOverlay.event(e); },
          function () {
            if (!rzp) return;
            var g = JSON.parse(JSON.stringify(gstat[rzp.pro]));
            g.offense = g.redzone = true;
            g.down = "2nd & 6 at " + g.opp + " 14";
            queue.push({ kind: "rz", who: [{ side: d.me.lineup.indexOf(rzp) >= 0 ? "me" : "them", p: rzp }], g: g });
            next();
          },
          function () {   // the other side goes ahead, then back a few seconds later
            var a = score.me, b = score.them;
            setScore(a, a > b ? a + 2.4 : b, null);
            setTimeout(function () { setScore(a, b, null); }, 4000);
          },
          function () { show(finalCard(), 6000); busy = true; }
        ];
        var k = 0;
        (function go() { if (!busy) steps[k++ % steps.length](); setTimeout(go, 7500); })();
      }
      if (/[?&]flash=1/.test(Q)) {   // and one scoring flash held on screen
        var last = Object.assign({}, evs[evs.length - 1]);
        last.player = evs.reduce(function (s, e) { return e.id === last.id ? s + e.pts : s; }, 0);
        setTimeout(function () { FLASH_MS = 1e9; window.FantasyOverlay.event(last); }, 100);
      }
    });
  }

  // ---------------- preview: replay a finished week
  var rp = /[?&]replay=([\w-]+)/.exec(Q);
  if (rp) {
    var speed = parseFloat((/[?&]speed=([\d.]+)/.exec(Q) || [])[1]) || 1;
    loadReplay(rp[1]).then(function (d) {
      now = d.events[0].t - 600000;   // ten minutes before the first play: nothing played yet
      window.FantasyOverlay.teams(d.me, d.them);
      // The exact totals after each play, the way the live engine sends them (here: added up from the
      // replay's plays, which come within a point or two of ESPN's official numbers)
      var tot = { me: 0, them: 0 }, per = {};
      var evs = d.events.map(function (e) {
        tot[e.side] += e.pts;
        per[e.id] = (per[e.id] || 0) + e.pts;
        var x = {};
        Object.keys(e).forEach(function (k) { x[k] = e[k]; });
        x.me = tot.me; x.them = tot.them; x.player = per[e.id];
        return x;
      });
      // ...and ESPN Fantasy's official final last, in the same queue, so nothing can land after it
      var official = {};
      d.me.lineup.concat(d.them.lineup).forEach(function (p) { official[p.id] = p.official; });
      evs.push({ final: true, me: d.me.official, them: d.them.official, players: official });
      PACE = speed;
      var i = 0;
      (function step() {
        if (i >= evs.length) return;
        if (evs[i].t && d.games) gstat = gamesAt(d.games, evs[i].t);
        window.FantasyOverlay.event(evs[i++]);
        setTimeout(step, GAP_MS / speed);
      })();
    });
  }
})();
