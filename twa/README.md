# Takar POS as an Android app (TWA)

`twa/` is a Trusted Web Activity: a 4 MB Android app (`app.takar.pos`, label "Takar") that opens the hosted POS,
https://possum.farizz-a.workers.dev/, in Chrome, without browser UI. Nothing of the web app is copied into it, so:

- printing, the offline cache, camera, share and notifications are Chrome's and behave exactly as in the installed PWA;
- the site's storage is Chrome's for that address, so on a tablet that already ran the PWA the app opens with the same
  sign-in, device pairing and unsent operations;
- a web change ships by deploying the site; rebuild the APK only when the shell changes (address, name, icon, colours).

The app opens in Chrome whenever the tablet has it (`app/src/main/java/app/takar/pos/LauncherActivity.java`), even
when another browser is the default. Before 1.0.2 it opened in the default browser: on Galaxy tablets that is Samsung
Internet, which darkened the POS in dark mode and, as version 27, ran a Chromium 125 engine. Without Chrome the
library picks a browser that supports TWAs, and without one it falls back to a Custom Tab.

Site storage belongs to the browser, so a tablet moving from Samsung Internet (1.0.1) to Chrome (1.0.2) starts with
Chrome's storage: send the queue first (no pending operations on the old app), then sign in again after the update.

## Full screen needs one file on the site

Android opens the app without an address bar only after it has checked that the site vouches for the app's signing
key: `public/.well-known/assetlinks.json` holds the key's SHA-256. Build and deploy the site once after adding it:

```sh
pnpm build
pnpm dlx wrangler deploy
curl -s https://possum.farizz-a.workers.dev/.well-known/assetlinks.json   # must print the JSON, not the app's HTML
```

Until then the app works, with an address bar at the top. If the app was installed before the file went live, clear
the app's data or reinstall it so Android checks again.

## Build

JDK 17 and the Android SDK from Homebrew (`openjdk@17`, `android-commandlinetools`):

```sh
cd twa
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew assembleRelease
```

The APK is `twa/app/build/outputs/apk/release/app-release.apk`. Raise `versionCode` in `app/build.gradle` for every
build you hand out; Android refuses to install a lower one over a newer one.

## The signing key

The release key is **not** in the repository: `~/Documents/takar-android/takar-pos-release.jks` with its passwords in
`~/Documents/takar-android/keystore.properties` (another path can be given in `TAKAR_KEYSTORE_PROPERTIES`). Without
that file the build produces an unsigned `app-release-unsigned.apk`.

Back up both files somewhere safe. Every update must be signed with the same key, and `assetlinks.json` names it. A
lost key means a new key, a new fingerprint in `assetlinks.json`, and uninstalling the old app before installing the
new one (the POS data survives, since it lives in Chrome).

## Moving the POS to another address

Change `host` in `app/build.gradle`, deploy `assetlinks.json` on the new site, raise `versionCode` and rebuild.
