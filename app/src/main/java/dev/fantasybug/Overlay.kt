package dev.fantasybug

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.io.ByteArrayInputStream

/**
 * The overlay over whatever is playing: overlay.html (scorebug, scoring popups, box score, league) in a
 * see-through window over the whole screen. It never takes the remote's keys or focus, so the app being
 * watched keeps the remote. It does take touches (a TV has none), which keeps Android from capping its
 * opacity at 80%. Needs "display over other apps" (appops SYSTEM_ALERT_WINDOW allow).
 *
 * The phone remote (RemoteService) picks the view: the scorebug, the box score, the league, or off. Off takes
 * the window away, so nothing is asked of ESPN.
 */
object Overlay {
    // The page's own address. Never a real host: every request to it is answered here, from the app.
    const val HOST = "fantasybug.invalid"
    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var sample = false   // the sample game, started from the fantasybug screen to be seen there
    private var screen = false   // the fantasybug screen is open on the TV
    /** Told when the phone turns the matchup on: the fantasybug screen then gets out of the way. */
    var onTurnedOn: (() -> Unit)? = null

    val showing get() = web != null
    val sampleShowing get() = web != null && sample

    /** What is on screen: "off", "bug" (the scorebug), "box" (the box score) or "league". */
    var view = "off"; private set
    val VIEWS = listOf("off", "bug", "box", "league")

    /** Straight to one view (the phone remote), or "next". Any thread. */
    fun setView(ctx: Context, v: String) {
        val c = ctx.applicationContext
        main.post {
            val want = if (v == "next") VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.size] else v
            when {
                want !in VIEWS -> {}
                want == "off" -> hide(c)
                web == null || sample -> {   // off, or the sample game: your matchup, drawn once its page has loaded (onPageFinished)
                    if (web != null) hide(c)
                    view = want
                    show(c)
                    onTurnedOn?.invoke()
                }
                else -> { view = want; apply() }
            }
        }
    }

    private fun apply() {
        val js = when (view) {
            "box" -> "FantasyOverlay.box(true)"
            "league" -> "FantasyOverlay.leagueView(true)"
            else -> "FantasyOverlay.box(false); FantasyOverlay.leagueView(false)"
        }
        web?.evaluateJavascript("window.FantasyOverlay && (function () { $js; })()", null)
    }

    /** Runs [js] in the overlay page on the main thread; [done] gets its answer as JSON, or null when the overlay is off. */
    fun eval(js: String, done: (String?) -> Unit) {
        main.post { val w = web; if (w == null) done(null) else w.evaluateJavascript(js, done) }
    }

    /** Settings changed while it is up: load the page again, so it picks up the new team, delay and popups. */
    fun reload() { web?.let { main.post { it.reload() } } }

    /**
     * The fantasybug screen opened or closed. While it is open the live overlay steps aside, so it never covers
     * that screen's QR code; the sample game stays, since it was started there to be watched.
     */
    fun screenOpen(open: Boolean) {
        screen = open
        main.post { web?.visibility = if (open && !sample) View.INVISIBLE else View.VISIBLE }
    }

    fun show(ctx: Context, page: String = "overlay.html?live=1") {
        if (web != null) return
        sample = !page.contains("live=1")
        val c = ctx.applicationContext   // the window outlives whichever screen opened it
        if (view == "off") view = "bug"
        if (!Settings.canDrawOverlays(c)) {
            view = "off"
            Toast.makeText(c, "fantasybug needs \"Display over other apps\". Open fantasybug to switch it on.", Toast.LENGTH_LONG).show()
            return
        }
        val wm = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val v = WebView(c).apply {
            setBackgroundColor(Color.TRANSPARENT)
            isFocusable = false
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            // The page is laid out for the TV's own width in CSS pixels, which on a TV running at double density
            // (seen on a TCL: 1920x1080 at 320 dpi, so 960 CSS px wide) puts its small labels under WebView's 8 px
            // minimum font size; WebView then blows them up and the scorebug crowds. Let them be the size drawn.
            settings.minimumFontSize = 1
            settings.minimumLogicalFontSize = 1
            settings.textZoom = 100
            // "[timing]" lines from the page reach adb logcat (tag fantasybug), to line popups up with the broadcast
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    if (m.message().startsWith("[timing]")) Log.i("fantasybug", m.message())
                    else if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR)   // the page's own errors, for adb logcat
                        Log.w("fantasybug", "page: ${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})")
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = true
                override fun onPageFinished(v: WebView, url: String?) { apply() }   // the view picked, again after a reload
                override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                    val host = req.url.host ?: ""
                    if (host != HOST) return if (allowed(host)) null else blocked()   // the page talks to ESPN, and nobody else
                    return Espn.serve(c, req) ?: page(c, req.url.path ?: "")
                }
            }
        }
        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else WindowManager.LayoutParams.TYPE_PHONE
        // Not FLAG_NOT_TOUCHABLE: Android 12 and newer cap an untrusted overlay that lets touches through at
        // 80% opacity (seen on a TCL, alpha=0.8), so the box score could never be solid. A TV has no touch
        // screen, and FLAG_NOT_FOCUSABLE already leaves the remote's keys with the app being watched.
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START }
        try { wm.addView(v, lp) } catch (e: Exception) { v.destroy(); view = "off"; return }
        web = v
        if (screen && !sample) v.visibility = View.INVISIBLE
        v.loadUrl("https://$HOST/$page")
    }

    fun hide(c: Context) {
        view = "off"
        val v = web ?: return
        web = null
        main.post {
            try { (c.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v) } catch (e: Exception) {}
            v.destroy()
        }
    }

    /** The page's files from the copy built into the app, and the settings it may see as config.js. */
    fun page(c: Context, path: String): WebResourceResponse {
        val rel = path.removePrefix("/")
        if (rel.contains("..")) return missing()
        if (rel == "config.js") {
            val js = "window.FANTASYBUG = ${Prefs.pageConfig(c)};\n"
            return WebResourceResponse("application/javascript", "utf-8", ByteArrayInputStream(js.toByteArray()))
        }
        val type = mime(rel)
        val text = type.startsWith("text/") || type.endsWith("javascript") || type.endsWith("json")
        return try { WebResourceResponse(type, if (text) "utf-8" else null, c.assets.open("www/$rel")) } catch (e: Exception) { missing() }
    }

    fun mime(rel: String) = when (rel.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"; "json" -> "application/json"
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "svg" -> "image/svg+xml"; "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    /** ESPN's own hosts: its scoreboard and game feeds, ESPN Fantasy, and its pictures. */
    private fun allowed(host: String) = host == "espn.com" || host.endsWith(".espn.com") || host == "espncdn.com" || host.endsWith(".espncdn.com")

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun missing() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
