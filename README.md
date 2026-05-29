# ReplyHawk Agent

The desktop companion that runs on the operator's Mac. Watches Yelp + Thumbtack via a real Chrome under the hood, sends replies, talks to the ReplyHawk cloud.

## Status

**Day 1 of 5 — paired-with-cloud shell** ✅

What works now:
- First-run wizard to paste the agent token; verified against the cloud before saving
- Token stored in macOS Keychain via `keytar`
- 30s heartbeat loop pinging the cloud → green / red status dot
- Unpair flow clears the keychain

Coming next:
- Day 2: Embedded Chrome launcher (persistent profile per platform) + Yelp/Thumbtack watcher ports
- Day 3: Reply sender + SSE listener for "send-reply" commands from cloud
- Day 4: Menu-bar mode, status indicators, recovery on token expiry
- Day 5: Apple code-sign + notarize + signed `.dmg` + auto-update via `electron-updater`

## Development

```bash
cd ~/Desktop/ALEX/replyhawk-agent
npm install
npm run dev
```

On first run, paste your INGEST_API_KEY (`buy-big-watermelons` on Railway right now) to pair.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `REPLYHAWK_API_URL` | `https://lead-bot-next-production.up.railway.app` | Cloud endpoint. Override at build time to point at a local dev instance. |

## Build

```bash
# Local unsigned .dmg, for testing:
npm run build:unpack

# macOS signed .dmg (requires CSC_LINK + CSC_KEY_PASSWORD env vars):
npm run build:mac

# Full signed + notarized:
# 1) set notarize: true in electron-builder.yml
# 2) export APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
# 3) npm run build:mac
```

## Files

```
src/
├── main/
│   ├── index.ts           Electron main process + IPC handlers
│   ├── config.ts          API URL + keychain constants
│   ├── auth.ts            Token get/set/verify (Keychain via keytar)
│   └── heartbeat.ts       Liveness ping to cloud
├── preload/
│   ├── index.ts           Safe IPC bridge for the renderer
│   └── index.d.ts         Window.api typing
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx        Wizard + dashboard UI
        ├── main.tsx
        └── assets/main.css
```
