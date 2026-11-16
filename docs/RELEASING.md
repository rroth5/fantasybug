# Making a signed release

A release APK is signed with **your own key**. Android only installs an update over an earlier version if
both were signed with the same key, so this key is for life: lose it and nobody can update their
fantasybug, they have to uninstall and install again.

**The key never goes on GitHub.** `.gitignore` already leaves out `*.jks`, `*.keystore` and
`keystore.properties`.

## Once: make the key

```sh
mkdir -p ~/fantasybug-keys
keytool -genkeypair -v -keystore ~/fantasybug-keys/fantasybug-release.jks \
  -alias fantasybug -keyalg RSA -keysize 4096 -validity 36500
```

`keytool` comes with the JDK (`$JAVA_HOME/bin/keytool`). It asks for a password (pick a long one and save it
in your password manager) and a name; the rest can be left blank.

Then make `keystore.properties` in the repo folder (it is ignored by git):

```
storeFile=/Users/<you>/fantasybug-keys/fantasybug-release.jks
storePassword=<the password>
keyAlias=fantasybug
keyPassword=<the password>
```

## Back up the key

Copy `fantasybug-release.jks` somewhere that is not this computer and not GitHub: a USB stick in a drawer,
and your password manager (most can store a file). Keep the password with it.

## Each release

1. Raise `versionCode` (by 1) and `versionName` in `app/build.gradle.kts`.
2. Build: `sh scripts/build-apk.sh` makes `dist/fantasybug.apk`, signed with your key.
3. Run `scripts/privacy-scan.sh`. It must say **Clean**.
4. Commit, then tag and publish the release with the APK attached:

```sh
git tag v0.1.0 && git push --tags
gh release create v0.1.0 dist/fantasybug.apk --title "fantasybug 0.1.0" --notes "What changed"
```
