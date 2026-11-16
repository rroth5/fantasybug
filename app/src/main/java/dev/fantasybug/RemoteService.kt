package dev.fantasybug

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The phone remote: how fantasybug is run. A page on the phone with Scorebug, Box score, League and Off, the
 * look, the lineup, image quality, and tap-to-sync: tap the moment a play happens on screen, and that game's
 * popups move to match (FantasySync in overlay-live.js; a tap is timed when it reaches the TV, not by the
 * phone's clock). Each game keeps its own delay. It needs a small web server the phone can reach any time,
 * so it runs as a foreground service. Its link keeps working (a saved key and port), so the phone can keep
 * it on its home screen. It can change what the overlay shows and when, nothing else: no login, no team,
 * nothing from ESPN.
 *
 *   GET  /                 remote.html
 *   GET  /api/state        { view, ready, can_draw, def, games: [{ gid, name, delay, synced }], target, pick, recent, canUndo }
 *   POST /api/view         { view: "bug" | "box" | "league" | "off" | "next" }
 *   POST /api/tap          { id? }: the play the button named, or none (then the phone picks which: /api/choose)
 *   POST /api/choose       { id: "p:<game>:<play>" }
 *   POST /api/nudge        { gid, s: -30 .. 30 }: one game's delay
 *   POST /api/undo, /api/reset
 */
class RemoteService : Service() {
    private var server: MiniServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            nm.createNotificationChannel(NotificationChannel("remote", "Phone remote", NotificationManager.IMPORTANCE_MIN))
        @Suppress("DEPRECATION")
        val n = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, "remote") else Notification.Builder(this))
            .setContentTitle("fantasybug phone remote is on")
            .setSmallIcon(R.drawable.icon)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
        val ctx = applicationContext
        server = MiniServer(ctx, 8780..8789, { Prefs.remoteKey(ctx) }, "remote.html",
            { it.startsWith("remote") || it.startsWith("icon") }, { m, p, b, t -> api(ctx, m, p, b, t) },
            open = { it == "/api/pair/ask" || it == "/api/pair/finish" }, cors = true).also {
            if (it.start()) {
                House.announce(ctx, it.port)   // so the other TVs in the house can find this one
                Thread { Thread.sleep(3000); House.tidy(ctx) }.start()   // and stale entries (a TV reinstalled) go from its list, once it knows its own address
            }
            running = it
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        server?.let { if (it.port > 0) House.announce(applicationContext, it.port) }   // fantasybug opened: announce again, in case the TV went quiet
        return START_STICKY
    }

    override fun onDestroy() {
        House.quiet(applicationContext)
        server?.stop()
        if (running === server) running = null
        server = null
        super.onDestroy()
    }

    private fun api(ctx: Context, method: String, path: String, b: JSONObject, arrived: Long): JSONObject {
        if (method == "GET" && path == "/api/state") return state(ctx)
        if (method != "POST") throw Exception("Not found")
        return when (path) {
            "/api/view" -> {
                val v = b.optString("view").ifEmpty { b.optString("mode") }
                if (v !in Overlay.VIEWS && v != "next") throw Exception("Not a view")
                if (v != "off" && !Settings.canDrawOverlays(ctx)) throw Exception("The TV doesn't allow fantasybug to draw over other apps yet. Open fantasybug on the TV.")
                Overlay.setView(ctx, v)
                Thread.sleep(150)   // the view changes on the TV's main thread: let it, so the reply says where it landed
                JSONObject().put("ok", true).put("view", Overlay.view)
            }
            // a play's id: a popup's number, or "p:<game>:<play>" (digits, colons and the p only)
            "/api/tap", "/api/choose" -> {
                val id = b.optString("id").filter { it.isDigit() || it == ':' || it == 'p' }.take(64)
                val arg = if (id.isEmpty()) "null" else JSONObject.quote(id)
                sync(if (path == "/api/tap") "tap($arrived, $arg)" else "choose($arg)")
            }
            "/api/nudge" -> {
                val gid = b.optString("gid").filter { it.isDigit() }.take(20)
                if (gid.isEmpty()) throw Exception("Which game?")
                sync("nudge(\"$gid\", ${b.optInt("s").coerceIn(-30, 30)})")
            }
            // the look, the image quality and the lineup widget: kept by the overlay page itself (its own storage)
            "/api/look" -> {   // { look: "pill" | "notch", pos: "tl" .. "br", nx: 0 .. 100 }
                val look = b.optString("look").takeIf { it == "pill" || it == "notch" } ?: "pill"
                val pos = b.optString("pos").takeIf { it in setOf("tl", "tc", "tr", "bl", "bc", "br") } ?: "tr"
                page("look(\"$look\", \"$pos\", ${b.optInt("nx", 50).coerceIn(0, 100)})")   // { look, pos, nx }
            }
            "/api/quality" -> {   // { q: "low" | "med" | "high" }
                val q = b.optString("q").takeIf { it in setOf("low", "med", "high") } ?: throw Exception("Not a quality")
                page("quality(\"$q\")").takeIf { !it.optBoolean("ok", true) } ?: JSONObject().put("ok", true).put("quality", q)
            }
            "/api/lineup" -> {   // { on, pos: "tl" | "ml" | "bl" | "tr" | "mr" | "br", both }
                val o = JSONObject()
                if (b.has("on")) o.put("on", b.optBoolean("on"))
                if (b.has("both")) o.put("both", b.optBoolean("both"))
                b.optString("pos").takeIf { it in setOf("tl", "ml", "bl", "tr", "mr", "br") }?.let { o.put("pos", it) }
                page("lineup($o)")   // { on, pos, both }
            }
            "/api/name" -> {   // { name }: what this TV is called on the phone remote
                Prefs.setTvName(ctx, b.optString("name"))
                running?.let { House.announce(ctx, it.port) }
                House.share(ctx)   // the other TVs show the new name too
                state(ctx)
            }
            // ---- the house: the other TVs this phone remote can run
            "/api/find" -> JSONObject().put("tvs", House.find(ctx))   // the fantasybug TVs on the Wi-Fi
            "/api/link" -> {   // { addr, code? }: without a code, that TV shows one; with it, the two link
                val addr = b.optString("addr").trim()
                if (!House.lanAddr(addr)) throw Exception("That isn't a TV's address on your home network (like 192.168.x.x:8780).")
                val code = b.optString("code").filter { it.isDigit() }
                if (code.isEmpty()) House.linkAsk(ctx, addr) else House.linkFinish(ctx, addr, code)
                state(ctx).put("ok", true)
            }
            "/api/unlink" -> { House.unlink(ctx, b.optString("id")); state(ctx) }
            "/api/house" -> { House.merge(ctx, b.optJSONArray("house")); Thread { House.tidy(ctx) }.start(); JSONObject().put("ok", true) }   // from another TV in the house
            "/api/house/leave" -> { House.forget(ctx, b.optString("id")); JSONObject().put("ok", true) }
            // pairing, from another TV (no key: these only show a code, or check one)
            "/api/pair/ask" -> { House.ask(ctx, b.optString("from", "another TV")); JSONObject().put("ok", true) }
            "/api/pair/finish" -> JSONObject().put("house", House.finish(ctx, b.optString("code"), b.optJSONArray("house")))
            "/api/undo" -> sync("undo()")
            "/api/reset" -> sync("reset()")
            else -> throw Exception("Not found")
        }
    }

    /** One FantasySync call in the overlay page (overlay-live.js), waiting up to 3 s for its answer. */
    private fun sync(expr: String): JSONObject {
        val r = ask("window.FantasySync ? FantasySync.$expr : null")
            ?: return JSONObject().put("ok", false).put("msg", "Turn your matchup on first (Scorebug above). Syncing works while it's showing.")
        return JSONObject(r)
    }

    /** One FantasyOverlay call (the look, quality, lineup), with what it answers: the look or lineup it now has. */
    private fun page(expr: String): JSONObject {
        val r = ask("window.FantasyOverlay ? FantasyOverlay.$expr : null")
            ?: return JSONObject().put("ok", false).put("msg", "Turn your matchup on first (Scorebug above).")
        return try { JSONObject(r) } catch (e: Exception) { JSONObject().put("ok", true) }
    }

        private fun ask(js: String): String? {
        val out = AtomicReference<String?>(null)
        val done = CountDownLatch(1)
        Overlay.eval(js) { out.set(it); done.countDown() }
        done.await(3, TimeUnit.SECONDS)
        return out.get()?.takeIf { it != "null" }
    }

    /** The view, whether it can show at all, and the overlay's sync state (each game's delay, the play to tap for). */
    private fun state(ctx: Context): JSONObject {
        val st = (if (Overlay.showing) ask("window.FantasySync ? FantasySync.state() : null") else null)?.let { JSONObject(it) }
            ?: JSONObject().put("games", JSONArray()).put("def", Prefs.delay(ctx)).put("live", false)
        if (BuildConfig.SUPPORT_URL.isNotEmpty()) st.put("support", BuildConfig.SUPPORT_URL)   // "help me pay my league dues"
        return st.put("view", Overlay.view).put("tv", Prefs.tvName(ctx)).put("house", House.all(ctx))
            .put("ready", Prefs.login(ctx) != null && Prefs.teamId(ctx) != null)
            .put("can_draw", Settings.canDrawOverlays(ctx))
    }

    companion object {
        @Volatile private var running: MiniServer? = null

        /** The phone remote's link, while it runs. */
        fun url(ctx: Context): String? = running?.url()

        /** Running (it is how fantasybug is run). Call it from a screen the person is looking at, or at boot. */
        fun sync(ctx: Context) {
            val c = ctx.applicationContext
            val i = Intent(c, RemoteService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i) else c.startService(i)
            } catch (e: Exception) {}   // not allowed from the background on this TV: the next screen opened starts it
        }
    }
}

/** After the TV restarts, or fantasybug is updated: the phone remote again. (Some TVs, TCL among them, hold the restart one back.) */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (i.action == Intent.ACTION_BOOT_COMPLETED || i.action == Intent.ACTION_MY_PACKAGE_REPLACED) RemoteService.sync(c)
    }
}
