package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.CanonicalJson
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.io.ByteArrayInputStream
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import okhttp3.Protocol

object PinnedTls {
    fun client(desktop: PairedDesktop): OkHttpClient {
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(CanonicalJson.decodeBase64Url(desktop.certificate))) as X509Certificate
        certificate.checkValidity()
        require(CanonicalJson.base64Url(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)) == desktop.spki)
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("paired", certificate) }
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keyStore) }
        val trust = factory.trustManagers.single { it is X509TrustManager } as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val pin = "sha256/${java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded))}"
        val pinner = CertificatePinner.Builder().apply {
            desktop.endpoints.map { java.net.URI(it).host }.distinct().forEach { add(it, pin) }
        }.build()
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trust)
            .certificatePinner(pinner)
            .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
            .retryOnConnectionFailure(false)
            .build()
    }
}
