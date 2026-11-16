import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.fantasybug"
    compileSdk = 34
    defaultConfig {
        applicationId = "dev.fantasybug"
        minSdk = 23
        targetSdk = 34
        versionCode = 4
        versionName = "0.1.3"
        // Where "Help me pay my league dues" on the phone remote goes (supportUrl in gradle.properties). A fork sets
        // its own, or leaves it empty and the button is not shown. https only.
        val support = (project.findProperty("supportUrl") as String? ?: "").trim().takeIf { it.startsWith("https://") } ?: ""
        buildConfigField("String", "SUPPORT_URL", "\"" + support.filter { it.isLetterOrDigit() || it in ":/._-?=&%~" } + "\"")
    }
    buildFeatures { buildConfig = true }
    // The page (web/) goes into the app as assets/www, so the TV needs no computer to show it.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/www"))

    // A release build is signed with your own key, named in keystore.properties next to this file (never
    // committed; docs/RELEASING.md). Without one, release builds are signed with the debug key.
    val props = rootProject.file("keystore.properties").takeIf { it.isFile }?.let { f ->
        Properties().apply { f.inputStream().use { load(it) } }
    }
    signingConfigs {
        if (props != null) create("release") {
            storeFile = rootProject.file(props.getProperty("storeFile"))
            storePassword = props.getProperty("storePassword")
            keyAlias = props.getProperty("keyAlias")
            keyPassword = props.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    // Draws the setup QR code (Apache License 2.0)
    implementation("com.google.zxing:core:3.5.3")
}

// web/ -> assets/www, leaving out what is only for the browser preview
val bundleWeb by tasks.registering(Sync::class) {
    from(rootProject.file("web"))
    into(layout.buildDirectory.dir("generated/www/www"))
    exclude("**/*.md", "**/.*")
}
tasks.named("preBuild") { dependsOn(bundleWeb) }
