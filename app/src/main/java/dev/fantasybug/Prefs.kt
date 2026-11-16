package dev.fantasybug

import android.content.Context
import org.json.JSONObject

/**
 * Everything fantasybug remembers, in the app's private storage on the TV. The ESPN login (league id,
 * espn_s2 and SWID) is kept apart from the rest and never reaches the page: the page only sees the team,
 * the delay and which popups to show (config.js), and Espn adds the cookies on the way out.
 */
object Prefs {
    const val DEFAULT_DELAY_S = 58
    const val MAX_DELAY_S = 300
    /** The popups that can be switched off, as the page calls them, with the words the settings screen shows. */
    val POPUPS = listOf(
        "plays" to "Scoring plays",
        "touchdowns" to "Touchdowns",
        "redzone" to "Red zone",
        "lead" to "Lead changes",
        "final" to "Final score",
    )

    private fun loginStore(c: Context) = c.applicationContext.getSharedPreferences("login", Context.MODE_PRIVATE)
    private fun settingsStore(c: Context) = c.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    class Login(val league: String, val s2: String, val swid: String) {
        /** The Cookie header for ESPN; empty for a public league, which needs none. */
        val cookie get() = if (s2.isEmpty() && swid.isEmpty()) "" else "espn_s2=$s2; SWID=$swid"
    }

    /** A login that checks out, or null: a league id of digits, and cookies with nothing that could split the header. */
    fun check(league: String, s2: String, swid: String): Login? {
        val l = league.trim(); val a = s2.trim(); val b = swid.trim()
        if (!l.matches(Regex("\\d{1,15}"))) return null
        if (a.isEmpty() != b.isEmpty()) return null   // both, or neither for a public league
        if ((a + b).any { it < ' ' || it == ';' || it.code > 126 }) return null
        return Login(l, a, b)
    }

    fun login(c: Context): Login? {
        val p = loginStore(c)
        fun get(k: String) = Secret.open(p.getString(k, "") ?: "")
        return check(get("league"), get("s2"), get("swid"))
    }

    fun saveLogin(c: Context, l: Login) {
        val old = login(c)
        loginStore(c).edit().putString("league", Secret.seal(l.league)).putString("s2", Secret.seal(l.s2))
            .putString("swid", Secret.seal(l.swid)).commit()
        if (old?.league != l.league) settingsStore(c).edit().remove("team_id").remove("team_name").commit()   // another league: pick again
    }

    fun forget(c: Context) {
        loginStore(c).edit().clear().commit()
        settingsStore(c).edit().remove("team_id").remove("team_name").commit()
    }

    fun teamId(c: Context): Int? = settingsStore(c).getInt("team_id", -1).takeIf { it >= 0 }
    fun teamName(c: Context): String = settingsStore(c).getString("team_name", "") ?: ""
    fun setTeam(c: Context, id: Int, name: String) {
        settingsStore(c).edit().putInt("team_id", id).putString("team_name", name).commit()
    }

    /** The phone remote's key, kept so a link saved on the phone keeps working. New one: the old links stop. */
    fun remoteKey(c: Context, renew: Boolean = false): String {
        val p = settingsStore(c)
        p.getString("remote_key", null)?.takeIf { !renew }?.let { return it }
        val k = newKey()
        p.edit().putString("remote_key", k).commit()
        return k
    }

    /** What this TV is called on the phone remote (and its home-screen icon), for a house with more than one. */
    fun tvName(c: Context): String = settingsStore(c).getString("tv_name", "") ?: ""
    fun setTvName(c: Context, n: String) { settingsStore(c).edit().putString("tv_name", n.trim().filter { it >= ' ' }.take(24)).commit() }

        private val rng = java.security.SecureRandom()
    fun newKey(): String = (1..10).map { "abcdefghjkmnpqrstuvwxyz23456789"[rng.nextInt(31)] }.joinToString("")

    fun delay(c: Context): Int = settingsStore(c).getInt("delay_s", DEFAULT_DELAY_S)
    fun setDelay(c: Context, s: Int) { settingsStore(c).edit().putInt("delay_s", s.coerceIn(0, MAX_DELAY_S)).commit() }

    fun popup(c: Context, key: String): Boolean = settingsStore(c).getBoolean("popup_$key", true)
    fun setPopup(c: Context, key: String, on: Boolean) { settingsStore(c).edit().putBoolean("popup_$key", on).commit() }

    /** What the page may know, as config.js gives it: window.FANTASYBUG. Never the login. */
    fun pageConfig(c: Context): JSONObject {
        val o = JSONObject()
        teamId(c)?.let { o.put("team_id", it) }
        o.put("delay_s", delay(c))
        val pop = JSONObject()
        POPUPS.forEach { (k, _) -> pop.put(k, popup(c, k)) }
        o.put("popups", pop)
        return o
    }

    /** The phone page's view of the settings: the same, plus whether a login is saved (never the login itself). */
    fun state(c: Context): JSONObject = pageConfig(c).apply {
        val l = login(c)
        put("league_id", l?.league ?: "")
        put("signed_in", l != null)
        put("private", l != null && l.cookie.isNotEmpty())
        put("team_name", teamName(c))
    }
}
