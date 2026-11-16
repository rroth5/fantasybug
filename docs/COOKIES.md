# Finding your league ID, espn_s2 and SWID

fantasybug reads your league the same way your web browser does when you open ESPN Fantasy. For a
**private** league (most are), that takes two codes ESPN keeps in your browser, called cookies:
**espn_s2** and **SWID**. A **public** league needs only the league ID.

You do this once, on a computer. It takes about two minutes.

## 1. The league ID

Open your league on [fantasy.espn.com](https://fantasy.espn.com). The web address has
`leagueId=` in it, followed by a number. That number is your league ID. (On the phone setup page you can
paste the whole address; fantasybug keeps just the number.)

## 2. espn_s2 and SWID, in Chrome or Edge

1. Open [fantasy.espn.com](https://fantasy.espn.com) and sign in.
2. Open the developer tools: **F12** on Windows, **Cmd + Option + I** on a Mac.
3. At the top of the panel, click **Application**. (If you can't see it, click **»** to find it.)
4. On the left, open **Cookies** and click **https://fantasy.espn.com**.
5. Type `espn_s2` in the **Filter** box. Double-click its **Value**, copy it. It is long, about 300 characters.
6. Type `SWID` in the Filter box. Copy its value, **including the curly brackets** `{ }`.

### In Safari

First switch on **Safari, Settings, Advanced, Show features for web developers**. Then sign in to
fantasy.espn.com, press **Cmd + Option + I**, choose **Storage**, then **Cookies**, and copy the same two
values.

### In Firefox

Sign in, press **F12** (or **Cmd + Option + I**), choose **Storage**, then **Cookies**, then
`https://fantasy.espn.com`, and copy the same two values.

## 3. Get them to your phone

Scan the QR code on the TV with your phone and paste the two values in. To move them from the computer to
the phone, a note to yourself works. Or skip the phone: open the address shown under the QR code in the
computer's browser (the computer must be on the same Wi-Fi as the TV) and type the code shown there.

## Keep them safe

These two codes let anyone who has them into your ESPN account, like a password. fantasybug keeps them
only on your TV and only sends them to ESPN. Don't post them anywhere, and delete the note once you're
done.

To cut them off, choose **Forget my ESPN login** on the fantasybug screen. Signing out of ESPN on the
computer you copied them from may also end them (ESPN doesn't say for sure).

## When it stops working

ESPN's espn_s2 lasts a long time, usually a season or more, but it can run out. If fantasybug's scorebug
stops showing your matchup, copy the two values again and scan the QR code.
