# Instructions for the AI agent installing fantasybug

You are helping someone put fantasybug on their TV. Assume they are not technical: plain words, one or two
questions at a time, and wait for each answer. The user guide is [docs/USER-GUIDE.md](docs/USER-GUIDE.md);
this file is how you do the same thing for them from their computer.

Your job, in this order, never skipping ahead:

1. **Find the TV** and check it can run fantasybug.
2. **Say what you will do** to the TV, and wait for a clear yes.
3. **Install and allow it** from the computer.
4. **Hand over to the phone**: they connect their ESPN league on their phone, not through you.
5. **Tidy up** and show them how to undo it.

Nothing on the TV changes before step 2 is a yes: no connecting, no "Allow USB debugging?" prompt, no installs.

## Never

- Never ask for, read out or store their **espn_s2**, **SWID**, ESPN password or league ID in this chat. They type
  those into the phone setup page the TV shows, and that page sends them only to the TV. You may explain how to
  find them ([docs/COOKIES.md](docs/COOKIES.md)).
- Never factory-reset a TV, switch off system apps, change settings beyond the ones below, or install any other app.
- Never commit, upload or paste anything from their TV or their league anywhere.
- If something fails, stop and say what happened in one line. Don't keep trying other things on their TV.

## 1. Find the TV

Ask: "Which TV is it (brand and model, or Fire TV Stick / Chromecast / Google TV Streamer)? Is it on, and on the
same Wi-Fi as this computer?" And: "Is fantasybug already on this TV, or on another TV in your house?" The answer
changes step 3 (update, don't reinstall) and step 4 (link the TVs).

- **Works:** Google TV and Android TV (Sony, TCL, Hisense, Philips, Xiaomi, Nvidia Shield, Chromecast with Google
  TV, Google TV Streamer, Onn) and Fire TV on Fire OS (Fire TV Stick 4K and newer, Cube, Fire TV smart TVs).
- **Doesn't work:** Samsung, LG, Roku, Apple TV, and Fire TV on Vega OS (2025 sticks and newer). Say so kindly:
  fantasybug is an Android app. A Google TV Streamer or a Fire TV Stick plugged into their TV is the way round it.
- **Fire TV sticks:** fantasybug isn't confirmed on low-memory sticks yet (README, "Which TVs work"). Suggest Low
  image quality and the pill look later, on the phone remote.

Ask them to read you the TV's **IP address**:
- **Fire TV:** Settings, My Fire TV, About, Network.
- **Google TV:** Settings, Network and Internet, the Wi-Fi network (or Settings, System, About, Status).

## 2. Say what you will do, and get a yes

Say, in plain words:

> "Here's the plan. On the TV you switch on Developer options and debugging, so this computer can talk to it.
> When I connect, the TV asks 'Allow USB debugging?': you tick 'Always allow' and press Allow. Then I install
> fantasybug and allow it to show over other apps. Then you set it up from your phone. Afterwards you can switch
> debugging off again, and removing fantasybug is one command or the TV's own Uninstall. Okay?"

Wait for a clear **yes** in their words. Their TV's IP address, or any other answer to a question, is not a yes:
if you asked for the IP and the go-ahead together and they only sent the IP, ask once more: "Thanks. Okay to go
ahead?" Then wait.

## 3. Install and allow it

**Get adb** (Google's free tool for talking to Android devices). Look for one already there first: `adb` on the
PATH, `~/Library/Android/sdk/platform-tools/adb` (Mac), `~/Android/Sdk/platform-tools/adb` (Linux), or a
`platform-tools` folder in their Downloads. If none works: download
platform-tools for their system from https://developer.android.com/tools/releases/platform-tools into `build/`
(git ignores it) and use `build/platform-tools/adb`. Tell them what you're downloading first.
On a Mac, the first connection may ask to allow finding devices on the local network: they say Allow (System
Settings, Privacy and Security, Local Network, if it didn't ask).

**Developer options on the TV** (they do this with the remote; walk them through it):
- **Fire TV:** Settings, My Fire TV, About: press OK on the first line (the device name) seven times. Back, then
  Developer options: **ADB debugging** On (and **Apps from Unknown Sources** is not needed for this).
- **Google TV:** Settings, System, About: press OK on **Android TV OS build** seven times. Back, then Settings,
  System, Developer options: **USB debugging** On, and **Network debugging** (or Wireless debugging) if there is one.

**Connect:** `adb connect <tv ip>:5555`, while they watch the TV for **Allow USB debugging?** (tick Always allow,
press Allow). Then `adb devices` shows the TV as `device`. If port 5555 refuses and the TV only has **Wireless
debugging**: on the TV, Wireless debugging, Pair device with pairing code; `adb pair <ip>:<pair port>` with the
code they read you, then `adb connect <ip>:<port shown>`.

**Install the latest release:**
```sh
mkdir -p dist && curl -fL -o dist/fantasybug.apk https://github.com/rroth5/fantasybug/releases/latest/download/fantasybug.apk
adb -s <tv ip>:5555 install -r dist/fantasybug.apk
```
First check whether it's there: `adb -s <tv ip>:5555 shell pm list packages dev.fantasybug`. If it is, this
is an **update**: `install -r` keeps its league login, settings, phone remote link and its place in the house.
Never uninstall to "start clean" unless they ask: uninstalling makes it a new TV (new phone remote link; the old
home-screen icon stops working, and the old copy has to be removed from the phone's TV list, which fantasybug
0.1.3 and newer does by itself the next time the TVs talk).
An older test copy signed differently fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE: say so, and what it costs,
and ask before `adb uninstall dev.fantasybug`.

**Allow it to show over other apps:**
- **Fire TV** (no setting for it on the TV): `adb -s <tv ip>:5555 shell appops set dev.fantasybug SYSTEM_ALERT_WINDOW allow`
- **Google TV:** the same command works. (By hand it's also on the TV: open fantasybug, Allow, then switch
  fantasybug on in the list.)

Check it: `adb -s <tv ip>:5555 shell appops get dev.fantasybug SYSTEM_ALERT_WINDOW` says `allow`.

Open it on the TV: `adb -s <tv ip>:5555 shell am start -n dev.fantasybug/.MainActivity`

## 4. Hand over to the phone

The TV now shows a QR code. Tell them:
1. Scan it with your phone (same Wi-Fi), and enter your league ID, and for a private league espn_s2 and SWID
   (docs/COOKIES.md shows where to find them, on a computer, in two minutes).
2. Pick your team, then tap **Open the phone remote** and add it to your home screen. (Reinstalled? Delete the
   old fantasybug icon from the phone first: its link no longer works.)
3. On the phone remote, **Name this TV** (at the bottom): "Bedroom", "Living room".
4. **More than one TV** (ask if you haven't): install on each the same way, then on the phone remote tap **+ Add a
   TV**, pick the other TV and type the 4-digit code it shows. One phone app then runs them all. The same panel
   has **Remove** for a TV that's gone.
5. During a game: **Scorebug** on the phone remote, and the big tap button once per game to line up the timing.

## 5. Tidy up, and the undo

- Debugging can go off again now (it's only needed to install and allow): Fire TV, Developer options, ADB
  debugging Off; Google TV, Developer options, USB and Network debugging Off.
- **Updating later:** in the TV's Downloader app, code **6503818** installs the newest version over the old one and
  keeps everything (no computer needed, since the permission stays). Or ask Claude Code again.
- **TCL TVs** don't let apps start themselves after a restart or update: open fantasybug once afterwards.
- **To remove fantasybug:** the TV's Settings, Apps, fantasybug, Uninstall; or `adb uninstall dev.fantasybug`.
  That deletes its ESPN login from the TV too.

## For people changing fantasybug

- Build: `sh scripts/build-apk.sh` (JDK 21, Android SDK platform 34). Preview the pages: `python3 tools/preview.py`.
- Never commit `config.json`, `.env`, `keystore.properties`, keys or APKs (`.gitignore` covers them). Run
  `scripts/privacy-scan.sh` before every push; it must say Clean.
- Privacy promises are in [docs/PRIVACY.md](docs/PRIVACY.md): no analytics, no servers of your own, the league
  login stays on the TV. Keep them.
