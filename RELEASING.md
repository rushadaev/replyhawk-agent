# Releasing updates

The installed app auto-updates from **GitHub Releases** (electron-updater). Once a client
has any version installed, every release you publish flows to them automatically — you
never touch their Mac again.

## One-time setup

1. **Make the repo public** (or use a public releases repo).
   electron-updater reads releases over HTTPS; a private repo would need a token baked
   into the app. `electron-builder.yml` → `publish.repo` currently points at
   `rushadaev/replyhawk-agent`. Public repo = auto-update just works.

2. **GitHub token for publishing** (only YOU need this, it's never in the app):
   github.com → Settings → Developer settings → Personal access tokens (classic) →
   scope `repo` → copy it. Export when releasing:
   ```bash
   export GH_TOKEN="ghp_…"
   ```

3. **Apple notarization creds** (same as builds):
   ```bash
   export APPLE_ID="arsholove@mail.ru"
   export APPLE_APP_SPECIFIC_PASSWORD="ixox-qvts-wzii-uhfk"
   export APPLE_TEAM_ID="VWWU573U9Y"
   ```
   (Put all four exports in ~/.zshrc so you don't retype them.)

## Shipping an update — every time

```bash
cd ~/Desktop/ALEX/replyhawk-agent
# 1. commit your changes
git add -A && git commit -m "…"
# 2. bump the version (this is what triggers clients to update)
npm version patch        # 0.1.0 → 0.1.1   (minor / major also fine)
# 3. build, sign, notarize, and publish to GitHub Releases
npm run release
# 4. push the version-bump commit + tag
git push && git push --tags
```

`npm run release` runs the pre-flight check, builds, signs with your Developer ID,
notarizes, and uploads the `.dmg`, `.zip`, and `latest-mac.yml` manifest to a GitHub
Release tagged with the new version.

## What the client sees

- On launch (and every 6h) the app checks the release manifest.
- If a newer version exists, it downloads in the background.
- It installs on the next quit/relaunch. No prompts, no manual steps.

## First install (the only manual step, once)

Build the first dmg locally and hand it over:
```bash
npm run dist:mac           # produces dist/ReplyHawk-Agent-<v>.dmg (no publish)
```
AirDrop that dmg → drag to Applications → open. From then on, `npm run release`
updates them over the air.

## Versioning note
electron-updater compares the `version` in package.json. **Always `npm version`**
before `npm run release` — if the version doesn't increase, clients won't update.
