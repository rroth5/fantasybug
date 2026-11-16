# Putting fantasybug on GitHub (first time)

GitHub is a website that keeps a copy of your code and its history. You start **private** (only you can
see it) and can make it public later. Each step below is one thing to type in the Terminal app, in the
`fantasybug` folder. Nothing is published until step 6.

## 1. Install GitHub's tool

Download the Mac installer from **cli.github.com** (the **Download for macOS** button, a `.pkg` file),
open it and follow the steps; it asks for your Mac password. (With Homebrew: `brew install gh`.)
Then close and reopen Terminal, and check it worked:

```sh
gh --version
```

## 2. Sign in (you do this part yourself)

```sh
gh auth login
```

Pick **GitHub.com**, then **HTTPS**, then **Yes** to "authenticate Git", then **Login with a web
browser**. It shows a short code; your browser opens, you sign in to GitHub and type that code. Your
password never passes through the Terminal.

## 3. Put your name on your work

This uses GitHub's private "noreply" email address, so your real email never appears in the code's history.

```sh
git config user.name "RRoth5"
git config user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
git add -A
git commit -m "fantasybug 0.1.0: first version"
```

## 4. Check for leaks

```sh
scripts/privacy-scan.sh
```

It must end with **Clean: nothing found.** If not, stop and fix what it lists first.

## 5. Look at what will be sent

```sh
git status
git log --stat
```

You should see no `config.json`, no `.env`, no `.jks` or `.apk` files.

## 6. Create the private repo and push

```sh
gh repo create fantasybug --private --source . --push
```

That makes `github.com/<your name>/fantasybug`, private, and sends your code to it. Open it with
`gh repo view --web`.

## Later: a signed release

When it works on your TV and you are ready to share an APK, follow [RELEASING.md](RELEASING.md): make your
signing key once, back it up somewhere safe (never on GitHub), build, scan, and
`gh release create`.

## Later: going public

Run `scripts/privacy-scan.sh` once more (it also checks the history), then
`gh repo edit --visibility public --accept-visibility-change-consequences`.

## After going public: a Downloader code

People install fantasybug by typing a short number into the Downloader app instead of a long address.
Make that number once (you do this yourself; the site has a captcha, and what you submit there is public):

1. Go to **go.aftvnews.com**.
2. Paste this address (GitHub's "newest release" link, so the code never needs changing):
   `https://github.com/RRoth5/fantasybug/releases/latest/download/fantasybug.apk`
3. Submit. You get a number, for example 12345.
4. Put that number in place of `DOWNLOADER-CODE` in `README.md` and `docs/USER-GUIDE.md`, commit and push.

It only works once the repo is public and has a release: a private repo's files need a GitHub login.
