# gstack → pi port (scripted)

This repo is a **scripted port layer** for [`garrytan/gstack`](https://github.com/garrytan/gstack) so it can be used from pi skill commands.

## What this does

- Pulls latest upstream `garrytan/gstack`
- Copies it into `port/gstack`
- Applies mechanical compatibility transforms for pi:
  - `~/.claude/skills/...` → `~/.pi/agent/skills/...`
  - `.claude/skills/...` → `.pi/skills/...`
  - `/review` style commands → `/skill:review`
  - `AskUserQuestion` wording → "ask the user in chat"
  - Removes `allowed-tools` frontmatter blocks (pi ignores these anyway)
- Writes `port/METADATA.json` with upstream commit/version and transform rules

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
/skill:review
/skill:ship
/skill:browse
/skill:qa
/skill:setup-browser-cookies
/skill:retro
```

## Update flow

When upstream changes:

```bash
./scripts/sync_from_upstream.py
./scripts/install.sh --global
```

That re-pulls upstream main, regenerates the port, and reinstalls.
