# Shipping ReplyHawk Agent — signed .dmg + on-site install

Everything you need to (1) build a signed+notarized .dmg and (2) install it on a
client's Mac smoothly. Do the one-time setup once; then it's `npm run dist:mac` forever.

---

## ONE-TIME: create the Developer ID cert + notarization creds

You're enrolled in the paid Apple Developer Program, but you only have *Apple
Development* certs (machine-locked). You need a **Developer ID Application** cert to
ship to other Macs.

### 1. Create the Developer ID Application certificate
- Open **Xcode → Settings → Accounts** → select your team → **Manage Certificates…**
- Click **+** (bottom-left) → **Developer ID Application**
- It appears in your login keychain. Verify:
  ```bash
  security find-identity -v -p codesigning | grep "Developer ID Application"
  ```
  You should now see a `Developer ID Application: <you> (TEAMID)` line.

### 2. Get your Team ID
- https://developer.apple.com/account → **Membership details** → copy the **Team ID** (10 chars).

### 3. Create an app-specific password (for notarization)
- https://account.apple.com → **Sign-In and Security → App-Specific Passwords → +**
- Label it "ReplyHawk notarize", copy the generated password (format `abcd-efgh-ijkl-mnop`).

### 4. Put the three values in your shell (do NOT commit these)
```bash
export APPLE_ID="your-apple-id@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="XXXXXXXXXX"
```
Add them to `~/.zshrc` so they persist, or paste before each build.

---

## BUILD the signed + notarized .dmg

```bash
cd ~/Desktop/ALEX/replyhawk-agent
npm run dist:mac
```

This: type-checks → builds → signs with Developer ID → uploads to Apple for
notarization (2–10 min) → staples the ticket → outputs:

```
dist/ReplyHawk-Agent-0.1.0.dmg
```

Verify it's properly signed + notarized before you leave for the client:
```bash
spctl -a -vvv -t install "dist/ReplyHawk Agent.app"   # should say: accepted, source=Notarized Developer ID
codesign --verify --deep --strict --verbose=2 "dist/ReplyHawk Agent.app"
```

If `spctl` says **accepted / Notarized Developer ID**, it will open with a plain
double-click on any Mac. That's the goal.

---

## ON-SITE: installing on the client's Mac (≈3 min)

1. **AirDrop / USB** the `.dmg` to his Mac.
2. Double-click the .dmg → drag **ReplyHawk Agent** into **Applications**.
3. Open it from Applications (double-click). With notarization it opens clean —
   no Gatekeeper prompt.
   - *If you skipped notarization:* right-click the app → Open → "Open" once. On
     macOS 15+ you may instead need **System Settings → Privacy & Security →
     scroll down → "Open Anyway"**.
4. **Pair:** paste his business's agent token (see "Per-client token" below).
5. **Connect Yelp:** click *Open Chrome* on the Yelp card → he signs into
   biz.yelp.com once → click *Start watching* → Chrome goes invisible.
6. **Connect Thumbtack:** same on the Thumbtack card.
7. Confirm both cards say **"Watching in background"** and the *last tick* time
   advances every 30s. Open the cloud dashboard to confirm a lead lands.
8. Auto-launch on login is on by default — it'll restart itself after a reboot.

### Pre-flight (do this on YOUR Mac before you go)
- [ ] `npm run dist:mac` produced a notarized .dmg (spctl accepted)
- [ ] You installed the .dmg on your own Mac from scratch and it paired + watched OK
- [ ] Chrome is installed on the client's Mac (the app needs Google Chrome present)
- [ ] You have his agent token written down
- [ ] Cloud dashboard is up: https://lead-bot-next-production.up.railway.app

---

## Per-client token (don't reuse the shared dev key)

Each business should have its own agent token so its leads stay isolated. To mint
one for the client, run against the cloud DB (Railway):

```bash
# from lead-bot-next/, with Railway linked:
railway ssh "node -e '
  import(\"./scripts/new-business.mjs\")
'"
```

(If that helper doesn't exist yet, ask Claude to add `scripts/new-business.ts` —
it inserts a row in businesses + a random token in agent_tokens and prints the token.)

For tomorrow's demo you *can* reuse the existing token, but a dedicated one is cleaner.

---

## Troubleshooting on-site

| Symptom | Fix |
|---|---|
| "App is damaged / can't be opened" | Not notarized. `xattr -dr com.apple.quarantine "/Applications/ReplyHawk Agent.app"` then reopen. |
| "Google Chrome is not installed" | Install Chrome from google.com/chrome. The app drives the system Chrome. |
| Pairing says 401 | Token doesn't match what's in the cloud. Re-copy it. |
| Watcher stuck "connecting" | He isn't logged into Yelp/Thumbtack yet, or login expired — click *Show window*, log in, *Hide*. |
| Nothing in dashboard | Leads only post when something NEW arrives after Start Watching. Submit a test lead to confirm. |
