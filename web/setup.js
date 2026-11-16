// The phone setup page: sign in to the ESPN league, pick a team, set the delay and the popups. Talks to the
// TV's small setup server (SetupServer.kt) with the key from the QR code; every change is saved at once.
(function () {
  "use strict";
  var KEY = (/[?&]k=([a-z0-9]+)/.exec(location.search) || [])[1] || "";
  var POPUPS = [["plays", "Scoring plays"], ["touchdowns", "Touchdowns"], ["redzone", "Red zone"], ["lead", "Lead changes"], ["final", "Final score"]];
  var $ = function (id) { return document.getElementById(id); };
  var state = {};

  function api(path, body) {
    return fetch("api/" + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Key": KEY, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || "The TV said no (" + r.status + ").");
        return d;
      });
    }, function () { throw new Error("Can't reach the TV. Is fantasybug still open on it, and is this phone on the same Wi-Fi?"); });
  }

  function draw(s) {
    state = s;
    $("status").textContent = !s.signed_in ? "Not set up yet." :
      s.team_name ? "All set: league " + s.league_id + ", " + s.team_name + "." : "Connected to league " + s.league_id + ". Now pick your team.";
    $("status").className = "status" + (s.signed_in && s.team_name ? " ok" : "");
    if (s.league_id && !$("league").value) $("league").value = s.league_id;
    if (s.private) { $("s2").placeholder = "saved on the TV (paste again to change)"; $("swid").placeholder = "saved on the TV"; }
    $("s-team").hidden = !s.signed_in;
    $("s-settings").hidden = !s.signed_in;
    $("forget").hidden = !s.signed_in;
    $("delay").textContent = s.delay_s + " s";
    var box = $("popups");
    box.textContent = "";
    POPUPS.forEach(function (p) {
      var l = document.createElement("label"), c = document.createElement("input");
      c.type = "checkbox";
      c.checked = !s.popups || s.popups[p[0]] !== false;
      c.addEventListener("change", function () { var o = {}; o[p[0]] = c.checked; save({ popups: o }); });
      l.appendChild(c);
      l.appendChild(document.createTextNode(" " + p[1]));
      box.appendChild(l);
    });
    $("remote-link").hidden = !s.remote_url;
    if (s.remote_url) $("remote-link").href = s.remote_url;
    markTeam();
  }

  function teams(list, league) {
    $("league-name").textContent = league ? league : "";
    var box = $("teams");
    box.textContent = "";
    list.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "team";
      b.dataset.id = t.id;
      var n = document.createElement("b");
      n.textContent = t.name;
      b.appendChild(n);
      if (t.owner) { var o = document.createElement("small"); o.textContent = t.owner; b.appendChild(o); }
      b.addEventListener("click", function () { save({ team_id: t.id, team_name: t.name }); });
      box.appendChild(b);
    });
    markTeam();
  }
  function markTeam() {
    Array.prototype.forEach.call(document.querySelectorAll(".team"), function (b) { b.classList.toggle("on", +b.dataset.id === state.team_id); });
  }

  var savedTimer;
  function save(change) {
    return api("settings", change).then(function (s) {
      draw(s);
      $("saved").hidden = false;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(function () { $("saved").hidden = true; }, 2500);
    }, function (e) { alert(e.message); });
  }

  $("reveal").addEventListener("change", function () {   // the codes are hidden like a password unless asked
    $("s2").classList.toggle("secret", !this.checked);
    $("swid").classList.toggle("secret", !this.checked);
  });

  $("league").addEventListener("input", function () {   // a pasted league address: keep the number
    var m = /leagueId=(\d+)/.exec(this.value);
    if (m) this.value = m[1];
  });

  $("login").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("login-err"), btn = $("connect");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Asking ESPN…";
    var s2 = $("s2").value.trim(), swid = $("swid").value.trim();
    if (s2 && swid && !/^\{.*\}$/.test(swid)) swid = "{" + swid.replace(/[{}]/g, "") + "}";   // the brackets are part of it
    api("login", { league_id: $("league").value.trim(), espn_s2: s2, SWID: swid }).then(function (d) {
      $("s2").value = ""; $("swid").value = ""; $("reveal").checked = false;   // nothing left on the phone's screen
      $("s2").classList.add("secret"); $("swid").classList.add("secret");
      draw(d);
      teams(d.teams || [], d.league);
      $("s-team").scrollIntoView({ behavior: "smooth" });
    }, function (e) {
      err.textContent = e.message;
      err.hidden = false;
    }).then(function () { btn.disabled = false; btn.textContent = "Connect"; });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-step]"), function (b) {
    b.addEventListener("click", function () { save({ delay_s: Math.max(0, Math.min(300, (state.delay_s || 0) + +b.dataset.step)) }); });
  });

  $("forget").addEventListener("click", function () {
    if (!confirm("Delete your league ID, espn_s2 and SWID from the TV?")) return;
    api("forget", {}).then(function (s) { $("teams").textContent = ""; $("league").value = ""; draw(s); }, function (e) { alert(e.message); });
  });

  if (!KEY) {   // typed the address by hand: ask for the code shown under it on the TV
    $("s-login").hidden = true;
    $("status").textContent = "Type the code shown on the TV, under the QR code: ";
    var code = document.createElement("input");
    code.autocapitalize = "off";
    code.placeholder = "code";
    var go = document.createElement("button");
    go.type = "button";
    go.textContent = "Go";
    go.addEventListener("click", function () { location.search = "?k=" + encodeURIComponent(code.value.trim().toLowerCase()); });
    $("status").appendChild(code);
    $("status").appendChild(go);
    return;
  }
  api("state").then(function (s) {
    draw(s);
    if (s.signed_in) api("teams", {}).then(function (d) { teams(d.teams || [], d.league); }, function () {});
  }, function (e) { $("status").textContent = e.message; });
})();
