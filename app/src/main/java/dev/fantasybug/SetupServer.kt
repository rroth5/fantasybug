package dev.fantasybug

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone setup page, only while the fantasybug screen is open on the TV. The QR code carries its
 * address and a one-time key; a new key every time the screen opens. It never sends the ESPN cookies
 * back: the phone only hears whether a login is saved.
 *
 *   GET  /                 setup.html (and its files)
 *   GET  /api/state        the settings, and whether a login is saved
 *   POST /api/login        { league_id, espn_s2, SWID } -> checks it with ESPN, saves it, { league, teams: [...] }
 *   POST /api/teams        the league's teams again
 *   POST /api/settings     { team_id, team_name, delay_s, popups: { plays: true, ... } } (any of them)
 *   POST /api/forget       the login and the team, gone
 */
class SetupServer(private val ctx: Context, private val changed: () -> Unit) {
    val key: String = Prefs.newKey()
    private val main = Handler(Looper.getMainLooper())
    private val server = MiniServer(ctx, 8765..8775, { key }, "setup.html", { it.startsWith("setup") || it.startsWith("icon") }, api = { m, p, b, _ -> api(m, p, b) })

    val url: String? get() = server.url()

    fun start() = server.start()
    fun stop() = server.stop()

    private fun api(method: String, path: String, b: JSONObject): JSONObject {
        if (path == "/api/state") return state()
        if (method != "POST") throw Exception("Not allowed")
        when (path) {
            "/api/login" -> {
                val l = Prefs.check(b.optString("league_id"), b.optString("espn_s2"), b.optString("SWID"))
                    ?: throw Exception("Check the league ID (digits only), and paste both espn_s2 and SWID, or neither for a public league.")
                val (name, teams) = Espn.teams(l)   // throws a message for the phone when ESPN says no
                Prefs.saveLogin(ctx, l)
                notifyChanged()
                return withTeams(name, teams)
            }
            "/api/teams" -> {
                val l = Prefs.login(ctx) ?: throw Exception("Sign in first.")
                val (name, teams) = Espn.teams(l)
                return withTeams(name, teams)
            }
            "/api/settings" -> {
                if (b.has("team_id")) Prefs.setTeam(ctx, b.getInt("team_id"), b.optString("team_name").take(80))
                if (b.has("delay_s")) Prefs.setDelay(ctx, b.getInt("delay_s"))
                b.optJSONObject("popups")?.let { p -> Prefs.POPUPS.forEach { (k, _) -> if (p.has(k)) Prefs.setPopup(ctx, k, p.getBoolean(k)) } }
                notifyChanged()
                return state()
            }
            "/api/forget" -> { Prefs.forget(ctx); notifyChanged(); return state() }
        }
        throw Exception("Not found")
    }

    /** The settings, and the phone remote's link (so the phone can go straight on to it). */
    private fun state(): JSONObject = Prefs.state(ctx).apply {
        RemoteService.url(ctx)?.let { put("remote_url", it) }
    }

    private fun withTeams(name: String, teams: List<Espn.Team>): JSONObject {
        val list = JSONArray()
        teams.forEach { list.put(JSONObject().put("id", it.id).put("name", it.name).put("abbrev", it.abbrev).put("owner", it.owner)) }
        return state().put("league", name).put("teams", list)
    }

    private fun notifyChanged() { main.post(changed) }
}
