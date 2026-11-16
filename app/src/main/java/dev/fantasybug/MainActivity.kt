package dev.fantasybug

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/**
 * The fantasybug screen on the TV: what is set up, a QR code for setting it up from a phone, and the
 * settings the remote can change (team, broadcast delay, which popups show). Everything is a plain
 * button, so the remote's arrows and OK do it all; left and right change the delay.
 */
class MainActivity : Activity() {
    private var server: SetupServer? = null
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var qr: ImageView
    private lateinit var qrText: TextView
    private lateinit var qrTitle: TextView
    private var showSetup = false
    private var drawnAt = 0L   // when the list was last drawn again   // the setup code on the right, though setup is done (to change league or team)
    private val green = Color.parseColor("#30d158")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#0c0c10"))
            setPadding(dp(48), dp(32), dp(48), dp(24))
        }
        val left = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        left.addView(text("fantasybug", 34f, Typeface.BOLD, Color.WHITE))
        status = text("", 17f, Typeface.NORMAL, Color.parseColor("#b0b0b8")).apply { setPadding(0, dp(4), 0, dp(12)) }
        left.addView(status)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply { addView(list); isVerticalScrollBarEnabled = false }
        left.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(left, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1.25f))

        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(40), dp(8), 0, 0)
        }
        qrTitle = text("", 20f, Typeface.BOLD, Color.WHITE).apply { gravity = Gravity.CENTER }
        right.addView(qrTitle)
        qr = ImageView(this).apply { setBackgroundColor(Color.WHITE); setPadding(dp(8), dp(8), dp(8), dp(8)) }
        right.addView(qr, LinearLayout.LayoutParams(dp(220), dp(220)).apply { topMargin = dp(12); bottomMargin = dp(12) })
        qrText = text("", 15f, Typeface.NORMAL, Color.parseColor("#b0b0b8")).apply { gravity = Gravity.CENTER }
        right.addView(qrText)
        root.addView(right, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        Overlay.screenOpen(true)
        // The phone turned the matchup on while this screen is up: leave it, so the scorebug is seen at once over
        // whatever is behind (a first press must visibly work), and this screen's QR code is never covered.
        Overlay.onTurnedOn = {
            if (!isFinishing) {
                android.widget.Toast.makeText(this, "fantasybug is on. It shows over whatever you watch.", android.widget.Toast.LENGTH_LONG).show()
                finish()
            }
        }
        server = SetupServer(this) { refresh(); drawQr(); Overlay.reload() }.also { it.start() }
        RemoteService.sync(this)
        drawQr()
        refresh()
    }

    override fun onPause() {
        super.onPause()
        Overlay.screenOpen(false)
        Overlay.onTurnedOn = null
        server?.stop()
        server = null
    }

    private fun setUp() = Prefs.login(this) != null && Prefs.teamId(this) != null

    /**
     * The code on the right: the setup page's until a league and team are set (or when asked for, to change
     * them), then the phone remote's, which is how fantasybug is run.
     */
    private fun drawQr() {
        val remote = setUp() && !showSetup
        qrTitle.text = if (remote) "Your phone remote" else "Set up from your phone"
        val url = if (remote) RemoteService.url(this) else server?.url
        if (url == null) {
            qr.setImageDrawable(ColorDrawable(Color.parseColor("#222228")))
            if (remote && MiniServer.lanAddress() != null) {   // it is starting: look again in a moment
                qrText.text = "Starting…"
                qr.postDelayed({ if (!isFinishing) drawQr() }, 700)
            } else qrText.text = "The TV is not on a home network right now.\nConnect it to Wi-Fi and open fantasybug again."
            return
        }
        qr.setImageBitmap(qrBitmap(url, dp(204)))
        qrText.text = if (remote)
            "Scan it, then add the page to your phone's home screen.\nDuring the game, run fantasybug from it:\nthe views, the look, your lineup and the timing.\n\nThis TV's address: ${url.substringAfter("//").substringBefore("/")}"
        else "Point your phone's camera at the code.\nYour phone must be on the same Wi-Fi.\n\nOr type: ${url.substringBefore("/?")}\nand the code ${server?.key}"
    }

    /** Draws the whole list again from the saved settings. Keeps the focus on the same row. */
    private fun refresh() {
        val focused = list.indexOfChild(list.focusedChild)
        list.removeAllViews()
        drawnAt = SystemClock.uptimeMillis()
        val login = Prefs.login(this)
        val team = Prefs.teamName(this)
        status.text = when {
            login == null -> "Not set up yet. Scan the code with your phone to sign in to your ESPN league."
            team.isEmpty() -> "League ${login.league}. Pick your team below, or on your phone."
            else -> "League ${login.league} · $team"
        }

        val canDraw = Settings.canDrawOverlays(this)
        if (!canDraw) row("Allow \"Display over other apps\" (needed)") { askOverlay() }

        if (Overlay.sampleShowing) row("Stop the sample game") { Overlay.hide(this); refresh() }
        else row("Watch a sample game (no ESPN needed)") {
            Overlay.hide(this)   // in place of your matchup, if it is up (the phone remote brings it back)
            Overlay.show(this, "overlay.html?replay=week&speed=3&box=0")
            refresh()
        }

        header("Settings")
        row("Team: ${team.ifEmpty { "not picked" }}") { pickTeam() }
        val delay = row(delayText()) {}
        delay.setOnKeyListener { _, code, e ->
            if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
            val step = if (e.repeatCount > 8) 5 else 1
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT -> { Prefs.setDelay(this, Prefs.delay(this) - step); delay.text = delayText(); scheduleReload(); true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { Prefs.setDelay(this, Prefs.delay(this) + step); delay.text = delayText(); scheduleReload(); true }
                else -> false
            }
        }
        Prefs.POPUPS.forEach { (k, label) ->
            val b = row("") {}
            fun draw() { b.text = "$label popups: ${if (Prefs.popup(this, k)) "On" else "Off"}" }
            draw()
            b.setOnClickListener { Prefs.setPopup(this, k, !Prefs.popup(this, k)); draw(); Overlay.reload() }
        }
        header("Phone remote")
        if (setUp()) row(if (showSetup) "Show the phone remote's code" else "Change league or team (show the setup code)") {
            showSetup = !showSetup
            drawQr()
            refresh()
        }
        row("New phone remote link (the old one stops working)") {
            Prefs.remoteKey(this, renew = true)
            showSetup = false
            drawQr()
            AlertDialog.Builder(this).setMessage("Done. Scan the new code on the right with each phone that should run fantasybug.")
                .setPositiveButton("OK", null).show()
        }
        if (canDraw) row("\"Display over other apps\": allowed") { askOverlay() }
        if (login != null) row("Forget my ESPN login") {
            AlertDialog.Builder(this).setTitle("Forget your ESPN login?")
                .setMessage("fantasybug deletes your league ID, espn_s2 and SWID from this TV. You can scan the code again any time.")
                .setPositiveButton("Forget it") { _, _ -> Prefs.forget(this); Overlay.hide(this); refresh(); drawQr() }
                .setNegativeButton("Cancel", null).show()
        }

        val target = list.getChildAt(if (focused >= 0) focused else 0)
        if (target != null && target.isFocusable) target.requestFocus() else firstButton()?.requestFocus()
    }

    private fun delayText() = "Broadcast delay: ${Prefs.delay(this)} s   ◀ ▶" +
        if (Prefs.delay(this) == Prefs.DEFAULT_DELAY_S) "" else "   (usual ${Prefs.DEFAULT_DELAY_S})"

    private val reloadSoon = Runnable { Overlay.reload() }
    private fun scheduleReload() { list.removeCallbacks(reloadSoon); list.postDelayed(reloadSoon, 1500) }

    private fun firstButton(): View? = (0 until list.childCount).map { list.getChildAt(it) }.firstOrNull { it is Button }

    private fun pickTeam() {
        val login = Prefs.login(this)
        if (login == null) {
            AlertDialog.Builder(this).setMessage("Sign in to your ESPN league first: scan the code with your phone.")
                .setPositiveButton("OK", null).show()
            return
        }
        status.text = "Asking ESPN for your league's teams…"
        Thread {
            val r = try { Result.success(Espn.teams(login).second) } catch (e: Exception) { Result.failure(e) }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                refresh()
                r.onSuccess { teams ->
                    val labels = teams.map { t -> t.name + if (t.owner.isNotEmpty()) "  ·  ${t.owner}" else "" }.toTypedArray()
                    AlertDialog.Builder(this).setTitle("Which team is yours?")
                        .setItems(labels) { _, i -> Prefs.setTeam(this, teams[i].id, teams[i].name); refresh(); drawQr(); Overlay.reload() }
                        .show()
                }.onFailure { e -> AlertDialog.Builder(this).setMessage(e.message).setPositiveButton("OK", null).show() }
            }
        }.start()
    }

    /** The TV's own "Display over other apps" page. Many Google TVs have none: then say how to allow it. */
    private fun askOverlay() {
        val tries = listOf(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION),
        )
        for (i in tries) {
            try { startActivity(i); return } catch (e: Exception) {}
        }
        AlertDialog.Builder(this).setTitle("Display over other apps")
            .setMessage("This TV has no page for it in Settings, so it has to be allowed once from a computer " +
                "(the fantasybug guide shows how, in two commands):\n\nadb shell appops set $packageName SYSTEM_ALERT_WINDOW allow")
            .setPositiveButton("OK", null).show()
    }

    private fun header(s: String) {
        list.addView(text(s, 15f, Typeface.BOLD, green).apply {
            isAllCaps = true
            letterSpacing = 0.08f
            setPadding(0, dp(18), 0, dp(6))
        })
    }

    private fun row(label: String, click: () -> Unit): Button {
        val b = Button(this).apply {
            text = label
            isAllCaps = false
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f)
            setPadding(dp(18), 0, dp(18), 0)
            minHeight = 0; minimumHeight = 0
            stateListAnimator = null
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_focused), rounded(Color.WHITE))
                addState(intArrayOf(), rounded(Color.parseColor("#1c1c22")))
            }
            setTextColor(android.content.res.ColorStateList(
                arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()),
                intArrayOf(Color.parseColor("#0c0c10"), Color.WHITE)))
            // one press, one button: a press that redraws the list must not also press the button now in its place
            setOnClickListener { if (SystemClock.uptimeMillis() - drawnAt > 600) click() }
        }
        list.addView(b, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { bottomMargin = dp(8) })
        return b
    }

    private fun rounded(c: Int) = GradientDrawable().apply { setColor(c); cornerRadius = dp(10).toFloat() }

    private fun text(s: String, sp: Float, style: Int, color: Int) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTypeface(typeface, style)
        setTextColor(color)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun qrBitmap(s: String, size: Int): Bitmap {
        val m = QRCodeWriter().encode(s, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0))
        val px = IntArray(m.width * m.height)
        for (y in 0 until m.height) for (x in 0 until m.width) px[y * m.width + x] = if (m[x, y]) Color.BLACK else Color.WHITE
        return Bitmap.createBitmap(px, m.width, m.height, Bitmap.Config.RGB_565)
    }
}
