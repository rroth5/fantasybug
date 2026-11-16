package dev.fantasybug

import android.content.Context
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * A very small web server on the home network, for the phone pages (setup and the phone remote). It
 * serves the page's own files from the app, and answers /api/... only with the right key (the "X-Key"
 * header, which the page takes from the link in the QR code). Nothing it is sent is written to a log.
 *
 * @param files the page files it may serve (path in assets/www), and what "/" opens
 * @param api   method, path, JSON body, when it arrived (ms) -> JSON reply; throw with a message for the phone to show
 */
class MiniServer(
    private val ctx: Context,
    private val ports: IntRange,
    private val key: () -> String,
    private val index: String,
    private val files: (String) -> Boolean,
    private val api: (String, String, JSONObject, Long) -> JSONObject,
    /** /api paths that need no key: TV-to-TV pairing, which only shows a code or checks one. */
    private val open: (String) -> Boolean = { false },
    /** Answer pages from the other TVs' addresses too (the phone remote runs every TV in the house from one page). */
    private val cors: Boolean = false,
) {
    private var server: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(4)
    var port = 0; private set

    /** The address for a QR code, with the key, or null when the TV has no home network address. */
    fun url(): String? = if (port == 0) null else lanAddress()?.let { "http://$it:$port/?k=${key()}" }

    fun start(): Boolean {
        for (p in ports) {
            try {
                val s = ServerSocket()
                s.reuseAddress = true
                s.bind(InetSocketAddress(p))
                server = s; port = p
                break
            } catch (e: Exception) {}
        }
        val s = server ?: return false
        Thread {
            while (!s.isClosed) {
                val c = try { s.accept() } catch (e: Exception) { break }
                pool.execute { try { handle(c) } catch (e: Exception) {} finally { try { c.close() } catch (e: Exception) {} } }
            }
        }.apply { isDaemon = true }.start()
        return true
    }

    fun stop() {
        try { server?.close() } catch (e: Exception) {}
        server = null
        port = 0
        pool.shutdownNow()
    }

    private fun handle(sock: Socket) {
        val arrived = System.currentTimeMillis()   // a tap's moment: before anything else is read
        sock.soTimeout = 15000
        val inp = BufferedInputStream(sock.getInputStream())
        val line = readLine(inp) ?: return
        val parts = line.split(" ")
        if (parts.size < 2) return
        val method = parts[0]
        val target = parts[1]
        val headers = HashMap<String, String>()
        while (true) {
            val h = readLine(inp) ?: return
            if (h.isEmpty()) break
            val i = h.indexOf(':')
            if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
        }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len > 16384) return send(sock, 413, "application/json", err("Too big"))
        val body = ByteArray(len)
        var got = 0
        while (got < len) { val n = inp.read(body, got, len - got); if (n < 0) break; got += n }

        val path = target.substringBefore('?')
        if (cors && method == "OPTIONS") return send(sock, 204, "text/plain", ByteArray(0))   // the browser asking first
        if (path.startsWith("/api/")) {
            if (!open(path) && headers["x-key"] != key()) return send(sock, 403, "application/json", err("This link has expired. Scan the QR code on the TV again."))
            val reply = try {
                api(method, path, if (len > 0) JSONObject(String(body, Charsets.UTF_8)) else JSONObject(), arrived)
            } catch (e: Exception) {
                return send(sock, 400, "application/json", err(e.message ?: "Something went wrong"))
            } finally {
                body.fill(0)   // the login, if this was one: not left lying in memory longer than needed
            }
            return send(sock, 200, "application/json", reply.toString().toByteArray())
        }
        if (method != "GET") return send(sock, 405, "text/plain", "Not allowed".toByteArray())
        val rel = if (path == "/") index else path.removePrefix("/")
        if (rel.contains("..") || !(files(rel) || rel.startsWith("fonts/"))) return send(sock, 404, "text/plain", "Not found".toByteArray())
        val bytes = try { ctx.assets.open("www/$rel").use { it.readBytes() } } catch (e: Exception) {
            return send(sock, 404, "text/plain", "Not found".toByteArray())
        }
        send(sock, 200, Overlay.mime(rel), bytes)
    }

    private fun err(m: String) = JSONObject().put("error", m).toString().toByteArray()

    private fun send(sock: Socket, code: Int, type: String, body: ByteArray) {
        val reason = mapOf(200 to "OK", 204 to "No Content", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found", 405 to "Method Not Allowed", 413 to "Too Large")[code] ?: "Error"
        val text = type.startsWith("text/") || type.endsWith("json") || type.endsWith("javascript")
        val head = "HTTP/1.1 $code $reason\r\nContent-Type: $type${if (text) "; charset=utf-8" else ""}\r\nContent-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n" +
            (if (cors) "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: X-Key, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST\r\n" +
                "Access-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n" else "") +
            "Connection: close\r\n\r\n"
        val out = sock.getOutputStream()
        out.write(head.toByteArray())
        out.write(body)
        out.flush()
    }

    private fun readLine(inp: InputStream): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val c = inp.read()
            if (c < 0) return if (b.size() == 0) null else b.toString("UTF-8")
            if (c == '\n'.code) return b.toString("UTF-8").trimEnd('\r')
            if (b.size() > 8192) return null
            b.write(c)
        }
    }

    companion object {
        /** The TV's address on the home network (Wi-Fi or Ethernet), as the phone would reach it. */
        fun lanAddress(): String? = try {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { it.isSiteLocalAddress }?.hostAddress
        } catch (e: Exception) { null }
    }
}
