# ReplyHawk Agent — task runner.
#
# Secrets (Apple notarization + GitHub publish token) are read from the environment.
# Put them in a local, git-ignored `.env` (see .env.example) — it's auto-loaded below —
# or export them in your shell. They are NEVER committed.
#
#   make            → list targets
#   make dev        → run the app locally (ReplyHawk branding + dock icon)
#   make dmg        → signed + notarized .dmg in dist/ (no publish)
#   make release    → bump patch, build, notarize, publish to GitHub, push, mark latest
#   make release-minor / release-major

SHELL := /bin/bash
REPO  := rushadaev/replyhawk-agent

# Auto-load .env if present, and export everything to recipe shells.
-include .env
export

.PHONY: help dev build typecheck lint dmg release release-minor release-major \
        bump-patch bump-minor bump-major _build-publish publish-latest clean check-apple check-gh

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

dev: ## Run the app in dev mode
	npm run dev

build: ## Typecheck + bundle (electron-vite build)
	npm run build

typecheck: ## TypeScript typecheck (node + web)
	npm run typecheck

lint: ## ESLint
	npm run lint

dmg: check-apple ## Build a signed + notarized .dmg locally (no publish)
	npm run dist:mac
	@echo "→ dist/ReplyHawk-Agent-$$(node -p "require('./package.json').version").dmg"

# --- Release: bump → build+notarize+publish → push → mark the draft as latest ----------
# Creds are checked FIRST so a missing key can't leave a dangling version bump + tag.
release: check-apple check-gh bump-patch _build-publish ## Patch release (0.1.3 → 0.1.4) end-to-end
release-minor: check-apple check-gh bump-minor _build-publish ## Minor release (0.1.x → 0.2.0)
release-major: check-apple check-gh bump-major _build-publish ## Major release (0.x → 1.0.0)
publish: _build-publish ## Build + publish the CURRENT version (no bump)

bump-patch:
	npm version patch
bump-minor:
	npm version minor
bump-major:
	npm version major

_build-publish: check-apple check-gh
	npm run release
	git push origin HEAD --tags
	@$(MAKE) --no-print-directory publish-latest

publish-latest: check-gh ## Flip the current version's draft release to published + latest
	@VER=v$$(node -p "require('./package.json').version"); \
	 RID=$$(curl -s -H "Authorization: Bearer $$GH_TOKEN" \
	   "https://api.github.com/repos/$(REPO)/releases?per_page=15" \
	   | python3 -c "import sys,json;v='$$VER';print(next((r['id'] for r in json.load(sys.stdin) if r['tag_name']==v),''))"); \
	 if [ -z "$$RID" ]; then echo "✗ no release found for $$VER (did publish run?)"; exit 1; fi; \
	 curl -s -X PATCH -H "Authorization: Bearer $$GH_TOKEN" -H "Accept: application/vnd.github+json" \
	   "https://api.github.com/repos/$(REPO)/releases/$$RID" -d '{"draft":false,"make_latest":"true"}' >/dev/null \
	   && echo "✓ Published $$VER as latest → https://github.com/$(REPO)/releases/tag/$$VER"

clean: ## Remove build artifacts
	rm -rf out dist

check-apple:
	@test -n "$$APPLE_ID" && test -n "$$APPLE_APP_SPECIFIC_PASSWORD" && test -n "$$APPLE_TEAM_ID" \
	  || { echo "✗ Apple signing env missing. Set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (see .env.example)"; exit 1; }

check-gh:
	@test -n "$$GH_TOKEN" || { echo "✗ GH_TOKEN missing (GitHub token with repo scope). See .env.example"; exit 1; }

.DEFAULT_GOAL := help
