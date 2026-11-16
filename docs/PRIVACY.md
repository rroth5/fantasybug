# Privacy

**Short version:** your league ID, espn_s2 and SWID go from your phone to your TV, and from your TV only
to ESPN. fantasybug's makers never receive them, never see them, and have no way to. There is no
fantasybug server, account, analytics, crash reporting or tracking of any kind.

## What fantasybug keeps, and where

| What | Where it lives | Who can see it |
|---|---|---|
| League ID, espn_s2, SWID | Only on your TV, in fantasybug's private storage, **encrypted** with a key held by your TV's Android Keystore | Nobody but the app on that TV. Other apps can't read it, and a copy of the files is useless on any other device. |
| Your team, broadcast delay, popup choices | Only on your TV, in fantasybug's private storage | The same |
| The phone remote's link key | Only on your TV (and in the link on your phone, if you keep it) | Anyone you give the link to can show or hide the overlay and change its timing. Nothing else. |
| Each game's synced delay, for the day | Only on your TV, in the overlay's own storage | Nothing about you: ESPN's game number and a number of seconds |
| The look, lineup, image quality and this TV's name | Only on your TV | Nothing about you |

Nothing is backed up: fantasybug opts out of Google's cloud backup and of copying to a new device, so
your login never leaves the TV that way either.

## Where it goes

| From | To | What |
|---|---|---|
| Your phone | Your TV, over your home Wi-Fi | What you type on the setup page |
| Your TV | ESPN Fantasy (`fantasy.espn.com`) | Your league ID and cookies, to read your league, exactly as your browser does |
| Your TV | ESPN's public scoreboard, game feeds and pictures (`espn.com`, `espncdn.com`) | Nothing about you: public NFL data |

That is the complete list. The overlay page inside the app is only allowed to talk to ESPN's own
addresses: anything else it tried to reach would be blocked.

## The phone pages

- **Setup** only works while the fantasybug screen is open on the TV, and needs the one-time code in the
  QR code (a new one every time the screen opens). It never sends your cookies back to the phone: it only
  says whether a login is saved. The cookie boxes are hidden like a password, and emptied once the TV has
  them. Your phone's browser is asked not to remember them.
- **Phone remote** (how fantasybug is run, so always on) can only switch views, change the look, lineup, image
  quality and the TV's name, and change the timing (tap-to-sync, each game's delay). It shows your
  matchup's score. A tap only sends "now" and which play; the TV times it. It can't see
  or change your login, your team or anything from ESPN. **New phone remote link** on the TV ends every
  old link.

Both pages are plain web pages on your home network (not HTTPS, which a TV can't easily offer). On a home
Wi-Fi with a password, other people can't read them. **Don't set up fantasybug on a public or shared
Wi-Fi** (a hotel, a dorm, a café).

## Deleting it

- **Forget my ESPN login** on the fantasybug screen deletes the league ID, cookies and team from the TV.
- Uninstalling fantasybug deletes everything, including the encryption key.
- To make the cookies useless everywhere, sign out of ESPN on the computer you copied them from (ESPN
  may not end them right away).

## For anyone building or changing fantasybug

- Never add analytics, crash reporting, update checks or any server of your own that receives a person's
  league data. If one is ever added, this page must say so first.
- Never log the league ID or cookies (`adb logcat` only gets `[timing]` lines about plays).
- `scripts/privacy-scan.sh` checks the repo for cookies, league names and home addresses before every push.
- Bug reports: ask for what happened, never for cookies, the league ID or full logs with them in.
