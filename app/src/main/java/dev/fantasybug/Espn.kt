package dev.fantasybug

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.Locale

/**
 * ESPN Fantasy for the overlay page. A private league needs the member's ESPN login cookies (espn_s2 and
 * SWID); they stay in the app's private store (Prefs) and never reach the page. The page asks for
 * espn/league?view=... and espn/logo?u=...; this adds the cookies and passes the request on, to ESPN
 * Fantasy's league address and its custom logo host only.
 */
object Espn {
    private const val LEAGUE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/%d/segments/0/leagues/%s"
    private const val LOGO_HOST = "mystique-api.fantasy.espn.com"

    /** The season ESPN is in: the year it started (a January playoff week is still last year's season). */
    fun season(): Int {
        val c = Calendar.getInstance()
        return if (c.get(Calendar.MONTH) >= Calendar.MARCH) c.get(Calendar.YEAR) else c.get(Calendar.YEAR) - 1
    }

    private fun leagueUrl(l: Prefs.Login) = String.format(Locale.ROOT, LEAGUE, season(), l.league)

    /** espn/league and espn/logo for the page; anything else is not ours (null). */
    fun serve(ctx: Context, req: WebResourceRequest): WebResourceResponse? {
        val u = req.url
        val path = u.path ?: return null
        return when {
            path.endsWith("/espn/league") -> {
                val l = Prefs.login(ctx) ?: return error(503)
                val q = u.encodedQuery?.let { "?$it" } ?: ""
                val headers = mutableMapOf<String, String>()
                if (l.cookie.isNotEmpty()) headers["Cookie"] = l.cookie
                req.requestHeaders["X-Fantasy-Filter"]?.let { headers["X-Fantasy-Filter"] = it }
                respond(fetch(leagueUrl(l) + q, headers), "application/json")
            }
            path.endsWith("/espn/logo") -> {
                val target = u.getQueryParameter("u") ?: return error(400)
                val t = try { URL(target) } catch (e: Exception) { return error(400) }
                if (t.protocol != "https" || t.host != LOGO_HOST) return error(400)   // the cookies go to ESPN only
                val l = Prefs.login(ctx) ?: return error(503)
                val px = (u.getQueryParameter("px")?.toIntOrNull() ?: LOGO_PX).coerceIn(48, 256)   // the page's image quality
                logos.get("$px $target")?.let { return png(it) }
                val g = fetch(target, if (l.cookie.isEmpty()) emptyMap() else mapOf("Cookie" to l.cookie))
                if (g == null || g.code !in 200..299) return respond(g, null)
                val small = shrink(g.body, px) ?: return error(502)
                logos.put("$px $target", small)
                png(small)
            }
            else -> null
        }
    }

    class Team(val id: Int, val name: String, val abbrev: String, val owner: String)

    /**
     * The league's teams, for setup: checks the login works at the same time. Throws with a message for
     * the phone page when it does not (wrong league id, cookies that ESPN turns away, no network).
     */
    fun teams(l: Prefs.Login): Pair<String, List<Team>> {
        val r = fetch(leagueUrl(l) + "?view=mTeam&view=mSettings", if (l.cookie.isEmpty()) emptyMap() else mapOf("Cookie" to l.cookie))
        when {
            r == null -> throw Exception("The TV could not reach ESPN. Check its internet connection and try again.")
            r.code == 401 || r.code == 403 -> throw Exception(
                if (l.cookie.isEmpty()) "This league is private: it needs your espn_s2 and SWID."
                else "ESPN did not accept the espn_s2 and SWID. Copy them again (the guide shows how).")
            r.code == 404 -> throw Exception("ESPN has no league ${l.league} for the ${season()} season. Check the league ID.")
            r.code !in 200..299 -> throw Exception("ESPN answered with an error (${r.code}). Try again in a minute.")
        }
        val d = JSONObject(String(r!!.body, Charsets.UTF_8))
        val members = HashMap<String, JSONObject>()
        d.optJSONArray("members")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { members[it.optString("id")] = it } }
        val out = ArrayList<Team>()
        val ts = d.optJSONArray("teams") ?: JSONArray()
        for (i in 0 until ts.length()) {
            val t = ts.optJSONObject(i) ?: continue
            val ownerId = t.optString("primaryOwner").ifEmpty { t.optJSONArray("owners")?.optString(0) ?: "" }
            val m = members[ownerId]
            val owner = m?.let { (it.optString("firstName") + " " + it.optString("lastName")).trim().ifEmpty { it.optString("displayName") } } ?: ""
            val name = t.optString("name").ifEmpty { (t.optString("location") + " " + t.optString("nickname")).trim() }
            out.add(Team(t.optInt("id"), name, t.optString("abbrev"), owner))
        }
        if (out.isEmpty()) throw Exception("ESPN sent no teams for this league. Check the league ID.")
        return d.optJSONObject("settings")?.optString("name").orEmpty() to out
    }

    private class Got(val code: Int, val body: ByteArray, val type: String?)

    private fun fetch(url: String, headers: Map<String, String>): Got? = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 15000
        c.instanceFollowRedirects = false   // ESPN sends a login redirect for a refused private league; never follow it with the cookies
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        val code = c.responseCode
        val body = (if (code in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes() } ?: ByteArray(0)
        val type = c.contentType?.substringBefore(';')
        c.disconnect()
        Got(if (code in 300..399) 401 else code, body, type)
    } catch (e: Exception) {
        null
    }

    private fun respond(g: Got?, type: String?): WebResourceResponse {
        if (g == null) return error(502)
        val mime = type ?: g.type ?: "image/jpeg"
        return WebResourceResponse(mime, if (mime.endsWith("json")) "utf-8" else null, g.code, if (g.code in 200..299) "OK" else "Error",
            mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(g.body))
    }

    // A fantasy team's logo is whatever its owner uploaded, often 450 px or more: about 0.8 MB once decoded, for a
    // picture shown at 30 to 60 px. Shrunk here to the page's size (96 px: about 36 kB decoded), and kept, so a
    // logo is fetched and shrunk once, not again each time the league view or the box score draws it.
    private const val LOGO_PX = 96
    private val logos = android.util.LruCache<String, ByteArray>(48)

    private fun shrink(bytes: ByteArray, size: Int): ByteArray? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) null else {
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= size && bounds.outHeight / (sample * 2) >= size) sample *= 2
            val big = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            val scale = size.toFloat() / maxOf(big.width, big.height)
            val fit = if (scale < 1f) Bitmap.createScaledBitmap(big, maxOf(1, (big.width * scale).toInt()), maxOf(1, (big.height * scale).toInt()), true) else big
            val out = java.io.ByteArrayOutputStream()
            fit.compress(Bitmap.CompressFormat.PNG, 100, out)
            if (fit !== big) fit.recycle()
            big.recycle()
            out.toByteArray()
        }
    } catch (e: Exception) { null }   // not a picture Android can read: the page shows the initials instead

    private fun png(b: ByteArray) = WebResourceResponse("image/png", null, 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(b))

    private fun error(code: Int) =
        WebResourceResponse("application/json", "utf-8", code, "Error", emptyMap(), ByteArrayInputStream("{}".toByteArray()))
}
