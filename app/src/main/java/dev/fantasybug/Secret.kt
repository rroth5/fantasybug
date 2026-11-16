package dev.fantasybug

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the ESPN login before it is written to the app's storage, with a key the TV's Android
 * Keystore holds and never hands out. A copy of the app's files (a backup, a rooted TV) is then no use
 * without this TV. Uninstalling the app deletes the key with it.
 */
object Secret {
    private const val ALIAS = "fantasybug-login"
    private const val PLAIN = "p:"   // a TV whose Keystore fails: kept as before, in the app's private storage only

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return g.generateKey()
    }

    fun seal(s: String): String = try {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        Base64.encodeToString(c.iv + c.doFinal(s.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    } catch (e: Exception) {
        PLAIN + s
    }

    /** The text again, or "" when it can't be read (another TV's key, a wiped Keystore). */
    fun open(s: String): String {
        if (s.isEmpty()) return ""
        if (s.startsWith(PLAIN)) return s.removePrefix(PLAIN)
        return try {
            val b = Base64.decode(s, Base64.NO_WRAP)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
            String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)
        } catch (e: Exception) {
            ""
        }
    }
}
