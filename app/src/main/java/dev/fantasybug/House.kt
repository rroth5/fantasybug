package dev.fantasybug

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The TVs in the house, so one phone remote runs them all. Each TV keeps the others' phone remote links
 * ({ id, name, url, key }); the phone page then talks to whichever TV is picked, straight to that TV.
 *
 * Linking two TVs: the phone, on one TV's remote, finds the others on the Wi-Fi (each announces itself as
 * _fantasybug._tcp), picks one, and that TV shows a 4-digit code on its screen for two minutes. The code typed
 * on the phone proves the person is in the room: without it no TV hands its link to another. The two swap
 * their lists of the house, and each tells the TVs it already knew. Only phone remote links are shared:
 * never the ESPN login, which every TV keeps to itself.
 */
object House {
    private const val TYPE = "_fantasybug._tcp."
    private const val CODE_MS = 2 * 60000L
    private val main = Handler(Looper.getMainLooper())
    private val rng = SecureRandom()

    // ---------------- the house, as this TV keeps it

    private fun store(c: Context) = c.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** This TV's own id: random, made once, so the others know it after its address changes. */
    fun id(c: Context): String {
        val p = store(c)
        p.getString("tv_id", null)?.let { return it }
        val id = Prefs.newKey()
        p.edit().putString("tv_id", id).commit()
        return id
    }

    /** Its name on the phone: the one given on the phone remote, else the TV's own name from its settings ("Reed's Fire TV"), else its model. */
    fun name(c: Context): String = Prefs.tvName(c).ifEmpty {
        (try { Settings.Global.getString(c.contentResolver, "device_name") } catch (e: Exception) { null })?.trim().orEmpty()
    }.ifEmpty { Build.MODEL ?: "TV" }

    /** This TV, as the others keep it. Null until its phone remote is up. */
    fun self(c: Context): JSONObject? {
        val url = RemoteService.url(c)?.substringBefore("?") ?: return null
        return JSONObject().put("id", id(c)).put("name", name(c)).put("url", url).put("key", Prefs.remoteKey(c))
    }

    private fun others(c: Context): JSONArray = try { JSONArray(store(c).getString("house", "[]")) } catch (e: Exception) { JSONArray() }

    /** Every TV, this one first, for the phone page: { id, name, url, key, here }. */
    fun all(c: Context): JSONArray {
        val out = JSONArray()
        self(c)?.let { out.put(it.put("here", true)) }
        val o = others(c)
        for (i in 0 until o.length()) o.optJSONObject(i)?.let { out.put(it.put("here", false)) }
        return out
    }

    /** Takes in what another TV knows of the house: new TVs added, new names and addresses kept. */
    @Synchronized fun merge(c: Context, list: JSONArray?) {
        if (list == null) return
        val me = id(c)
        val byId = LinkedHashMap<String, JSONObject>()
        val o = others(c)
        for (i in 0 until o.length()) o.optJSONObject(i)?.let { byId[it.optString("id")] = it }
        for (i in 0 until list.length()) {
            val t = list.optJSONObject(i) ?: continue
            val id = t.optString("id")
            val url = t.optString("url")
            if (id.isEmpty() || id == me || !lanUrl(url) || !t.optString("key").matches(Regex("[a-z0-9]{6,20}"))) continue
            byId[id] = JSONObject().put("id", id).put("name", t.optString("name").take(24)).put("url", url).put("key", t.optString("key"))
        }
        store(c).edit().putString("house", JSONArray(byId.values).toString()).commit()
    }

    /** This TV leaves the house (or forgets one TV): the others are told, best effort. */
    /** A TV is taken out of the house (the phone's Remove): every TV forgets it, and it forgets them, best effort. */
    fun unlink(c: Context, id: String) {
        val o = others(c)
        val keep = JSONArray()
        var gone: JSONObject? = null
        for (i in 0 until o.length()) o.optJSONObject(i)?.let { if (it.optString("id") == id) gone = it else keep.put(it) }
        store(c).edit().putString("house", keep.toString()).commit()
        val me = id(c)
        Thread {
            gone?.let { g -> post(g.optString("url") + "api/house/leave", JSONObject().put("id", me), g.optString("key")) }
            for (i in 0 until keep.length()) keep.optJSONObject(i)?.let { t ->   // and the rest of the house forgets it too
                post(t.optString("url") + "api/house/leave", JSONObject().put("id", id), t.optString("key"))
            }
        }.start()
    }

    /**
     * Tidies the list: a TV reinstalled gets a new id and key at the same address, so two entries share one
     * address. The TV there answers only its current key: the entry it refuses is the stale one, and goes. An
     * address that doesn't answer at all (the TV is off) is left alone. Runs off the main thread.
     */
    fun tidy(c: Context) {
        val o = others(c)
        val selfUrl = self(c)?.optString("url")
        val byUrl = LinkedHashMap<String, MutableList<JSONObject>>()
        for (i in 0 until o.length()) o.optJSONObject(i)?.let { byUrl.getOrPut(it.optString("url")) { mutableListOf() }.add(it) }
        val stale = HashSet<String>()
        for ((url, list) in byUrl) {
            if (url == selfUrl) { list.forEach { stale.add(it.optString("id")) }; continue }   // this TV's own address: an old copy of itself
            if (list.size < 2) continue
            val alive = list.filter { t -> get(url + "api/state", t.optString("key")) == 200 }
            if (alive.isNotEmpty()) list.filter { it !in alive }.forEach { stale.add(it.optString("id")) }
        }
        stale.forEach { forget(c, it) }
    }

    private fun get(url: String, key: String): Int = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 6000
        conn.setRequestProperty("X-Key", key)
        val code = conn.responseCode
        conn.disconnect()
        code
    } catch (e: Exception) { 0 }

    /** Another TV left: forget it here. */
    fun forget(c: Context, id: String) {
        val o = others(c)
        val keep = JSONArray()
        for (i in 0 until o.length()) o.optJSONObject(i)?.let { if (it.optString("id") != id) keep.put(it) }
        store(c).edit().putString("house", keep.toString()).commit()
    }

    /** Tells every other TV in the house what this one knows (its name changed, a TV joined). */
    fun share(c: Context) {
        val list = all(c)
        val o = others(c)
        Thread {
            for (i in 0 until o.length()) {
                val t = o.optJSONObject(i) ?: continue
                post(t.optString("url") + "api/house", JSONObject().put("house", list), t.optString("key"))
            }
        }.start()
    }

    // ---------------- linking, on the TV that shows the code

    private var code: String? = null
    private var codeUntil = 0L
    private var tries = 0
    private var codeView: TextView? = null

    /** Another TV asks to link: a fresh code on this screen for two minutes (asking again replaces it). */
    @Synchronized fun ask(c: Context, from: String) {
        code = (1000 + rng.nextInt(9000)).toString()
        codeUntil = System.currentTimeMillis() + CODE_MS
        tries = 0
        showCode(c.applicationContext, "Link with ${from.take(24)}?\nType this code on your phone:  $code")
    }

    /** The code typed on the phone, passed on by the other TV: right, and the two TVs swap their houses. */
    @Synchronized fun finish(c: Context, typed: String, house: JSONArray?): JSONArray {
        val now = code
        if (now == null || System.currentTimeMillis() > codeUntil) throw Exception("The code ran out. Start again.")
        if (++tries > 5) { code = null; hideCode(); throw Exception("Too many wrong codes. Start again.") }
        if (typed.trim() != now) throw Exception("That's not the code on the TV. Try again.")
        code = null
        hideCode()
        val mine = all(c)   // before taking theirs in, so they get this TV and the ones it knew
        merge(c, house)
        Thread { tidy(c) }.start()   // a TV linking again after a reinstall: its old entry goes
        share(c)            // the TVs this one already knew learn about the new ones
        return mine
    }

    private fun showCode(c: Context, text: String) = main.post {
        removeCode()   // right now, not posted: a posted one would run after this and take the new code away
        if (!Settings.canDrawOverlays(c)) { Toast.makeText(c, text, Toast.LENGTH_LONG).show(); return@post }
        val v = TextView(c).apply {
            this.text = text
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            val d = resources.displayMetrics.density
            setPadding((32 * d).toInt(), (20 * d).toInt(), (32 * d).toInt(), (20 * d).toInt())
            background = GradientDrawable().apply { setColor(Color.parseColor("#F00C0C10")); cornerRadius = 18 * d; setStroke((3 * d).toInt(), Color.parseColor("#30D158")) }
        }
        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val lp = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE, PixelFormat.TRANSLUCENT)
            .apply { gravity = Gravity.CENTER }
        try { (c.getSystemService(Context.WINDOW_SERVICE) as WindowManager).addView(v, lp); codeView = v } catch (e: Exception) { return@post }
        main.postDelayed({ if (codeView === v) removeCode() }, CODE_MS)
    }

    private fun hideCode() = main.post { removeCode() }

    /** On the main thread only. */
    private fun removeCode() {
        val v = codeView ?: return
        codeView = null
        try { (v.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v) } catch (e: Exception) {}
    }

    // ---------------- linking, on the TV the phone is using

    /** Step 1: the other TV (at "address:port") shows its code. */
    fun linkAsk(c: Context, addr: String) {
        val r = post("http://$addr/api/pair/ask", JSONObject().put("from", name(c)), null)
            ?: throw Exception("Can't reach that TV. Is it on, with fantasybug opened once since it was switched on?")
        if (r.has("error")) throw Exception(r.optString("error"))
    }

    /** Step 2: the code from its screen; both TVs then know each other, and this one tells the rest. */
    fun linkFinish(c: Context, addr: String, typed: String) {
        val r = post("http://$addr/api/pair/finish", JSONObject().put("code", typed).put("house", all(c)), null)
            ?: throw Exception("Can't reach that TV.")
        if (r.has("error")) throw Exception(r.optString("error"))
        merge(c, r.optJSONArray("house"))
        tidy(c)
        share(c)
    }

    // ---------------- finding the others: each TV announces itself on the Wi-Fi

    private var registered: NsdManager.RegistrationListener? = null

    fun announce(c: Context, port: Int) {
        val nsd = c.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        quiet(c)
        val info = NsdServiceInfo().apply {
            serviceName = "fantasybug ${id(c)}"
            serviceType = TYPE
            this.port = port
            setAttribute("id", id(c))
            setAttribute("name", name(c))
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) {}
            override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) {}
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
        }
        try { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l); registered = l } catch (e: Exception) {}
    }

    fun quiet(c: Context) {
        val l = registered ?: return
        registered = null
        try { (c.getSystemService(Context.NSD_SERVICE) as NsdManager).unregisterService(l) } catch (e: Exception) {}
    }

    /** The other fantasybug TVs on the Wi-Fi, found in about four seconds: [{ id, name, addr }]. Runs off the main thread. */
    fun find(c: Context): JSONArray {
        val nsd = c.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return JSONArray()
        val found = ArrayList<NsdServiceInfo>()
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) {}
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceFound(i: NsdServiceInfo) { synchronized(found) { found.add(i) } }
            override fun onServiceLost(i: NsdServiceInfo) {}
        }
        try { nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, l) } catch (e: Exception) { return JSONArray() }
        Thread.sleep(3000)
        if (synchronized(found) { found.none { it.serviceName != "fantasybug ${id(c)}" } }) Thread.sleep(3000)   // nothing yet: some TVs answer late
        try { nsd.stopServiceDiscovery(l) } catch (e: Exception) {}
        val me = id(c)
        val out = JSONArray()
        val seen = HashSet<String>()
        for (s in synchronized(found) { found.toList() }) {   // one at a time: older Android resolves only one at once
            if (s.serviceName == "fantasybug $me") continue
            val done = CountDownLatch(1)
            var got: NsdServiceInfo? = null
            @Suppress("DEPRECATION")
            try {
                nsd.resolveService(s, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(i: NsdServiceInfo, e: Int) { done.countDown() }
                    override fun onServiceResolved(i: NsdServiceInfo) { got = i; done.countDown() }
                })
            } catch (e: Exception) { continue }
            done.await(2, TimeUnit.SECONDS)
            val r = got ?: continue
            @Suppress("DEPRECATION")
            val host = r.host?.hostAddress ?: continue
            val id = r.attributes["id"]?.let { String(it) } ?: continue
            if (id == me || !seen.add(id)) continue
            out.put(JSONObject().put("id", id).put("name", r.attributes["name"]?.let { String(it) } ?: "fantasybug TV")
                .put("addr", "$host:${r.port}"))
        }
        return out
    }

    // ---------------- small things

    /** Only TVs on the home network: an address like 192.168.x.x:8780. */
    fun lanAddr(addr: String): Boolean {
        val m = Regex("""(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})""").matchEntire(addr) ?: return false
        return try { InetAddress.getByName(m.groupValues[1]).isSiteLocalAddress } catch (e: Exception) { false }
    }

    private fun lanUrl(url: String) = Regex("""http://([\d.]+:\d+)/""").matchEntire(url)?.let { lanAddr(it.groupValues[1]) } == true

    /** A POST to another TV, JSON both ways; null when it can't be reached. Errors come back as { error }. */
    fun post(url: String, body: JSONObject, key: String?): JSONObject? = try {
        val u = URL(url)
        if (!lanAddr("${u.host}:${u.port}")) throw Exception("not on the home network")
        val conn = u.openConnection() as HttpURLConnection
        conn.connectTimeout = 4000
        conn.readTimeout = 8000
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        if (key != null) conn.setRequestProperty("X-Key", key)
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { String(it.readBytes()) } ?: "{}"
        conn.disconnect()
        try { JSONObject(text) } catch (e: Exception) { JSONObject().put("error", "That TV answered oddly.") }
    } catch (e: Exception) {
        android.util.Log.w("fantasybug", "house: can't reach ${url.substringBefore("/api")}: ${e.javaClass.simpleName}")
        null
    }
}
