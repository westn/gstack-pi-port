# gstack for pi (Pi-native port)

This repository is the Pi-native port of [`garrytan/gstack`](https://github.com/garrytan/gstack), maintained in [`westn/gstack-pi-port`](https://github.com/westn/gstack-pi-port).

> If you're installing for **pi**, clone this repo (not `garrytan/gstack`).

## Quick install (pi users)

```bash
git clone https://github.com/westn/gstack-pi-port.git
cd gstack-pi-port
./scripts/install.sh --global --build
```

Then run `/reload` inside pi and use skills via `/skill:<name>`.

## What this repo does

- Pulls latest upstream `garrytan/gstack`
- Copies it into `port/gstack`
- Applies mechanical compatibility transforms for pi:
  - `~/.claude/skills/...` → `~/.pi/agent/skills/...`
  - `.claude/skills/...` → `.pi/skills/...`
  - `/review` style commands → `/skill:review`
  - `AskUserQuestion` wording → "ask the user in chat"
  - Removes `allowed-tools` frontmatter blocks (pi ignores these anyway)
- Writes `port/METADATA.json` with upstream commit/version and transform rules

## What changed from upstream

- Skill paths are Pi-native (`~/.pi/agent/skills` and `.pi/skills`)
- Skill invocations are normalized to `/skill:<name>`
- User-facing docs are adjusted for Pi workflows and `AGENTS.md`
- Install flow uses this repository as the source of truth
- Model/provider selection is Pi-native and model-agnostic (use `pi --provider ... --model ...`)

## Existing port check (as of 2026-03-15)

Run:

```bash
./scripts/search_existing_ports.sh
```

Using `gh search repos`:

- Found upstream: `garrytan/gstack`
- Found related ports/wrappers:
  - `Ahacad/gstack` (Claude plugin wrapper)
  - `mphaxise/gstack-port-for-codex` (Codex port)
- **No pi-native gstack port found** in repository search results.

## Usage

### 1) Sync from upstream

```bash
cd gstack-pi-port
./scripts/sync_from_upstream.py
```

### 2) Install globally for pi

```bash
./scripts/install.sh --global
```

This installs to `~/.pi/agent/skills/gstack` and creates top-level skill symlinks in `~/.pi/agent/skills/` (required for pi recursive discovery).

If you also want to build browse runtime immediately:

```bash
./scripts/install.sh --global --build
```

### 3) Reload pi

Inside pi, run:

```text
/reload
```

Then invoke skills via:

```text
/skill:plan-ceo-review
/skill:plan-eng-review
/skill:plan-design-review
/skill:review
/skill:ship
/skill:browse
/skill:qa
/skill:qa-only
/skill:design-review
/skill:setup-browser-cookies
/skill:retro
/skill:design-consultation
/skill:document-release
/skill:gstack-upgrade
```

## Update flow

Recommended (single command, full process):

```bash
./scripts/update.sh
```

By default this runs:
1) upstream sync,
2) update-tooling sanity checks,
3) Pi-native harness sanity tests,
4) global install (`~/.pi/agent/skills/gstack`).

Common variants:

```bash
./scripts/update.sh --build        # also rebuild browse binary/deps
./scripts/update.sh --no-install   # repo update + verification only
./scripts/update.sh --project /path/to/repo --build
```

Manual equivalent (if you want to run pieces separately):

```bash
./scripts/sync_from_upstream.py
./scripts/install.sh --global
```

Optional (recommended) LLM audit via pi:

```bash
./scripts/llm_port_audit.py
```

That re-pulls upstream main, regenerates the port, reinstalls, and gives you an additional report-only quality pass for wording/porting artifacts.

### Pi-native depth guardrails (built into sync)

`./scripts/sync_from_upstream.py` now also:

- enforces Pi-native eval harness wording (`pi --mode json -p`),
- enforces model-agnostic prompt language (no provider-locked examples),
- fails fast if stale upstream terms reappear (e.g. `claude -p`, `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`),
- applies maintained overrides from `overrides/gstack/` for Pi-specific eval helper code.

So when someone clones this repo and asks pi to update, the sync step now catches/normalizes deeper porting drift automatically.

## Licensing

- Root wrapper/port tooling in this repository is licensed under MIT (`LICENSE`).
- Upstream-derived `garrytan/gstack` content remains under upstream MIT terms (`port/gstack/LICENSE`).
- See `NOTICE` for third-party attribution details.
