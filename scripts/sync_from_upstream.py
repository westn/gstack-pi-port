#!/usr/bin/env python3
"""Sync garrytan/gstack into a pi-friendly port directory.

Usage:
  python scripts/sync_from_upstream.py
"""

from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_DIR = REPO_ROOT / ".upstream" / "gstack"
PORT_DIR = REPO_ROOT / "port" / "gstack"
METADATA_PATH = REPO_ROOT / "port" / "METADATA.json"
OVERRIDES_DIR = REPO_ROOT / "overrides" / "gstack"

UPSTREAM_REPO = "https://github.com/garrytan/gstack.git"
UPSTREAM_BRANCH = "main"

DEFAULT_SKILL_COMMANDS = [
    "plan-ceo-review",
    "plan-eng-review",
    "review",
    "ship",
    "browse",
    "qa",
    "qa-only",
    "setup-browser-cookies",
    "retro",
    "gstack-upgrade",
    "plan-design-review",
    "design-review",
    # Legacy alias still present in some upstream docs/changelog entries.
    "qa-design-review",
    "design-consultation",
    "document-release",
]

# Filled dynamically from upstream skill folders in main().
SKILL_COMMANDS: list[str] = list(DEFAULT_SKILL_COMMANDS)

# Apply longer paths first.
PATH_REPLACEMENTS = [
    ("~/.claude/skills/gstack", "~/.pi/agent/skills/gstack"),
    ("$HOME/.claude/skills/gstack", "$HOME/.pi/agent/skills/gstack"),
    ("${HOME}/.claude/skills/gstack", "${HOME}/.pi/agent/skills/gstack"),
    (".claude/skills/gstack", ".pi/skills/gstack"),
    ("~/.claude/skills/", "~/.pi/agent/skills/"),
    ("$HOME/.claude/skills/", "$HOME/.pi/agent/skills/"),
    ("${HOME}/.claude/skills/", "${HOME}/.pi/agent/skills/"),
    (".claude/skills/", ".pi/skills/"),
    ("~/.claude/skills", "~/.pi/agent/skills"),
    ("$HOME/.claude/skills", "$HOME/.pi/agent/skills"),
    ("${HOME}/.claude/skills", "${HOME}/.pi/agent/skills"),
    (".claude/skills", ".pi/skills"),
    (".claude/", ".pi/"),
    (".claude", ".pi"),
]

PHRASE_REPLACEMENTS = [
    ("AskUserQuestion", "ask the user in chat"),
    ("Claude Code", "pi"),
    ("Claude:", "Agent:"),
    ("docs.anthropic.com/en/docs/claude-code", "www.npmjs.com/package/@mariozechner/pi-coding-agent"),
    (
        "git clone --depth 1 https://github.com/garrytan/gstack.git \"$TMP_DIR/gstack\"",
        "git clone --depth 1 https://github.com/westn/gstack-pi-port.git \"$TMP_DIR/gstack-pi-port\"",
    ),
    (
        "mv \"$TMP_DIR/gstack\" \"$INSTALL_DIR\"",
        "mv \"$TMP_DIR/gstack-pi-port/port/gstack\" \"$INSTALL_DIR\"",
    ),
    (
        "https://raw.githubusercontent.com/garrytan/gstack/main/VERSION",
        "https://raw.githubusercontent.com/westn/gstack-pi-port/main/port/gstack/VERSION",
    ),
    (
        "Open pi and paste this. Claude will do the rest.",
        "Open pi and paste this. The agent will do the rest.",
    ),
    (
        "git clone https://github.com/garrytan/gstack.git ~/.pi/agent/skills/gstack && cd ~/.pi/agent/skills/gstack && ./setup",
        "git clone https://github.com/westn/gstack-pi-port.git /tmp/gstack-pi-port && cd /tmp/gstack-pi-port && ./scripts/install.sh --global --build",
    ),
    (
        "Install gstack: run `git clone https://github.com/westn/gstack-pi-port.git",
        "Install gstack (Pi port): run `git clone https://github.com/westn/gstack-pi-port.git",
    ),
    (
        "/skill:qa, /skill:setup-browser-cookies",
        "/skill:qa, /skill:qa-only, /skill:setup-browser-cookies",
    ),
    (
        "and lists the available skills: /skill:plan-ceo-review, /skill:plan-eng-review, /skill:review, /skill:ship, /skill:browse, /skill:qa, /skill:setup-browser-cookies, /skill:retro,",
        "and lists the available skills: /skill:plan-ceo-review, /skill:plan-eng-review, /skill:review, /skill:ship, /skill:browse, /skill:qa, /skill:qa-only, /skill:setup-browser-cookies, /skill:retro,",
    ),
    (
        "and tells Claude that if gstack skills aren't working,",
        "and tells the user that if gstack skills aren't working,",
    ),
    (
        "Everything lives inside `.pi/`. Nothing touches your PATH or runs in the background.",
        "Everything lives inside `.pi/` (plus runtime state in `.gstack/`). Nothing touches your PATH or runs in the background.",
    ),
    (
        "This rebuilds symlinks so Claude can discover the skills.",
        "This rebuilds symlinks so pi can discover the skills.",
    ),
    (
        "https://claude.com/claude-code",
        "https://www.npmjs.com/package/@mariozechner/pi-coding-agent",
    ),
    ("See what Claude sees", "See what the agent sees"),
    ("prompt templates read by Claude", "prompt templates read by the agent"),
    ("tell Claude what to remember", "tell the agent what to remember"),
    (
        "SKILL.md files tell Claude how to use the browse commands.",
        "SKILL.md files tell the agent how to use the browse commands.",
    ),
    ("**Claude reads SKILL.md at skill load time.**", "**The agent reads SKILL.md at skill load time.**"),
    ("I tell Claude to go check staging.", "I tell the agent to go check staging."),
    ("where Claude needs eyes on a live URL.", "where the agent needs eyes on a live URL."),
    (
        "Want to brainstorm first with `/brainstorm`?",
        "Want to brainstorm first with `/skill:plan-ceo-review`?",
    ),
    # Keep commit trailer examples model-agnostic for pi's multi-provider support.
    (
        "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>",
        "Co-Authored-By: AI Assistant <noreply@ai-assistant.local>",
    ),
    ("noreply@anthropic.com", "noreply@ai-assistant.local"),
    ("(e.g., Claude, Copilot)", "(e.g., AI assistants such as Copilot)"),
    (
        "Uses the Anthropic API directly (not Agent SDK) to evaluate whether",
        "Uses pi CLI (with your configured provider/model) to evaluate whether",
    ),
    (
        "Requires: ANTHROPIC_API_KEY env var (or EVALS=1 with key already set)",
        "Requires: pi configured with provider credentials.",
    ),
    (
        "Run: EVALS=1 bun run test:eval\n *",
        "Run: EVALS=1 bun run test:evals\n *",
    ),
    (
        "Cost: ~$0.05-0.15 per run (sonnet)",
        "Cost: provider/model dependent (typically low for short judge prompts)",
    ),
    # E2E harness and judge are pi-native in this port.
    ("import Anthropic from '@anthropic-ai/sdk';\n", ""),
    (
        "// Run when EVALS=1 is set (requires ANTHROPIC_API_KEY in env)",
        "// Run when EVALS=1 is set (requires pi CLI + provider credentials configured)",
    ),
    (
        "// Fail fast if Anthropic API is unreachable — don't burn through 13 tests getting ConnectionRefused",
        "// Fail fast if pi's configured provider is unreachable — don't burn through expensive E2E runs.",
    ),
    (
        'echo "ping" | claude -p --max-turns 1 --output-format stream-json --verbose --dangerously-skip-permissions',
        'echo "ping" | pi --no-session --no-tools --mode text -p',
    ),
    (
        "Anthropic API unreachable — aborting E2E suite. Fix connectivity and retry.",
        "pi provider API unreachable — aborting E2E suite. Fix connectivity and retry.",
    ),
    (
        "// Outcome evals also need ANTHROPIC_API_KEY for the LLM judge",
        "// Outcome evals use the shared pi-based judge helper.",
    ),
    ("const hasApiKey = !!process.env.ANTHROPIC_API_KEY;", "const hasApiKey = true;"),
    (
        "E2E tests stream progress in real-time (tool-by-tool via `--output-format stream-json\n--verbose`).",
        "E2E tests stream progress in real-time (tool-by-tool via JSON mode events).",
    ),
    ("Key differences from Claude session-runner:", "Key differences from pi session-runner:"),
    (
        "- Uses `codex exec` instead of `claude -p`",
        "- Uses `codex exec` instead of `pi --mode json -p`",
    ),
    (
        "- Uses `--json` flag instead of `--output-format stream-json`",
        "- Uses `--json` flag instead of pi JSON mode events",
    ),
    (
        "- Uses `--output-format stream-json --yolo` instead of `--json -s read-only`",
        "- Uses `--output-format` + `stream-json` + `--yolo` instead of `--json -s read-only`",
    ),
    (
        "Parse an array of JSONL lines from `gemini -p --output-format stream-json`.",
        "Parse an array of JSONL lines from Gemini JSON event output (`gemini -p`).",
    ),
    (
        "// Check if Anthropic API key is available (needed for outcome evals)",
        "// Check if provider API access is available (needed for outcome evals)",
    ),
    (
        "// Fail fast if Anthropic API is unreachable — don't burn through tests getting ConnectionRefused",
        "// Fail fast if provider API is unreachable — don't burn through tests getting ConnectionRefused",
    ),
    (
        "model?: string;                // e.g. 'claude-sonnet-4-6' or 'claude-opus-4-6'",
        "model?: string;                // e.g. your configured pi model",
    ),
    (
        """const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are comparing two versions of CLI documentation for an AI coding agent.

VERSION A (baseline — hand-maintained):
${baseline}

VERSION B (auto-generated from source):
${genSection}

Which version is better for an AI agent trying to use these commands? Consider:
- Completeness (more commands documented? all args shown?)
- Clarity (descriptions helpful?)
- Coverage (missing commands in either version?)

Respond with ONLY valid JSON:
{"winner": "A" or "B" or "tie", "reasoning": "brief explanation", "a_score": N, "b_score": N}

Scores are 1-5 overall quality.`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Judge returned non-JSON: ${text.slice(0, 200)}`);
    const result = JSON.parse(jsonMatch[0]);
""",
        """const result = await callJudge<{ winner: 'A' | 'B' | 'tie'; reasoning: string; a_score: number; b_score: number }>(`You are comparing two versions of CLI documentation for an AI coding agent.

VERSION A (baseline — hand-maintained):
${baseline}

VERSION B (auto-generated from source):
${genSection}

Which version is better for an AI agent trying to use these commands? Consider:
- Completeness (more commands documented? all args shown?)
- Clarity (descriptions helpful?)
- Coverage (missing commands in either version?)

Respond with ONLY valid JSON:
{"winner": "A" or "B" or "tie", "reasoning": "brief explanation", "a_score": N, "b_score": N}

Scores are 1-5 overall quality.`);
""",
    ),
    ("CLAUDE.md", "AGENTS.md"),
]

# Apply only to docs/templates (not source code) so runtime semantics remain stable.
DOC_ONLY_PHRASE_REPLACEMENTS = [
    ("`claude -p`", "`pi --mode json -p`"),
    ("claude -p", "pi --mode json -p"),
    ("Anthropic API", "pi provider API"),
    ("ANTHROPIC_API_KEY", "pi provider credentials"),
    ("claude-sonnet-4-6", "your configured pi model"),
    ("Spawn real Claude session", "Spawn real pi session"),
    (
        "cat prompt | pi --mode json -p --output-format stream-json --verbose",
        "cat prompt | pi --mode json -p",
    ),
    (
        "as a subprocess with `--output-format stream-json --verbose`, streams NDJSON",
        "as a subprocess in JSON mode, streams JSONL",
    ),
    ("`pi --mode json -p --output-format stream-json --verbose`", "`pi --mode json -p`"),
    ("`--output-format stream-json --verbose`", "`JSON mode events`"),
    (
        "set pi provider credentials=sk-ant-...",
        "set one provider key (for example OPENAI_API_KEY=...)",
    ),
    (
        "Put your `pi provider credentials` in `.env`",
        "Put your provider API key in `.env`",
    ),
    (
        "Calls the pi provider API directly (not `pi --mode json -p`), so it works from anywhere including inside pi",
        "Uses the shared pi judge helper, so it works from anywhere including inside pi",
    ),
    (
        "Sonnet scores docs on clarity/completeness/actionability",
        "Configured model scores docs on clarity/completeness/actionability",
    ),
    (
        "- Auto-skips if running inside pi (`pi --mode json -p` can't nest)",
        "- Works in plain terminals and inside pi (plain terminal recommended for stable eval timing)",
    ),
    (
        "`test:evals` requires `pi provider credentials`.",
        "`test:evals` requires a provider API key configured for pi.",
    ),
    (
        "Uses Claude Sonnet to score generated SKILL.md docs on three dimensions:",
        "Uses your configured pi model to score generated SKILL.md docs on three dimensions:",
    ),
    (
        "# Must run from a plain terminal — can't nest inside pi or Conductor",
        "# Recommended from a plain terminal for stable timing (inside pi works but can be noisier)",
    ),
    (
        "# Needs pi provider credentials in .env — included in bun run test:evals",
        "# Needs a provider API key configured in .env — included in bun run test:evals",
    ),
]

REVIEW_PATH_REPLACEMENTS = [
    (".pi/skills/review/checklist.md", "~/.pi/agent/skills/review/checklist.md"),
    (".pi/skills/review/greptile-triage.md", "~/.pi/agent/skills/review/greptile-triage.md"),
    (".pi/skills/review/TODOS-format.md", "~/.pi/agent/skills/review/TODOS-format.md"),
]

BINARY_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".zip",
    ".gz",
    ".tgz",
    ".xz",
    ".bz2",
    ".7z",
    ".dylib",
    ".so",
    ".dll",
    ".exe",
    ".bin",
}


def run(cmd: list[str], cwd: Path | None = None) -> str:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return proc.stdout.strip()


def ensure_upstream() -> None:
    UPSTREAM_DIR.parent.mkdir(parents=True, exist_ok=True)

    if not (UPSTREAM_DIR / ".git").exists():
        if UPSTREAM_DIR.exists():
            shutil.rmtree(UPSTREAM_DIR)
        run(["git", "clone", "--depth", "1", "--branch", UPSTREAM_BRANCH, UPSTREAM_REPO, str(UPSTREAM_DIR)])
        return

    run(["git", "fetch", "origin", UPSTREAM_BRANCH, "--depth", "1"], cwd=UPSTREAM_DIR)
    run(["git", "checkout", UPSTREAM_BRANCH], cwd=UPSTREAM_DIR)
    run(["git", "reset", "--hard", f"origin/{UPSTREAM_BRANCH}"], cwd=UPSTREAM_DIR)
    run(["git", "clean", "-fdx"], cwd=UPSTREAM_DIR)


def discover_skill_commands() -> list[str]:
    """Discover slash-command skills from upstream folders.

    This keeps command normalization resilient when upstream adds new skills.
    """
    commands = set(DEFAULT_SKILL_COMMANDS)

    for marker in ("SKILL.md", "SKILL.md.tmpl"):
        for path in UPSTREAM_DIR.glob(f"*/{marker}"):
            name = path.parent.name
            if name and name != "node_modules":
                commands.add(name)

    preferred = [cmd for cmd in DEFAULT_SKILL_COMMANDS if cmd in commands]
    extras = sorted(cmd for cmd in commands if cmd not in DEFAULT_SKILL_COMMANDS)
    return preferred + extras


def normalize_pi_wording(text: str) -> str:
    """Polish mechanical phrase replacements into natural, stable phrasing."""
    updated = text

    wording_replacements = [
        ("## ask the user in chat Format", "## User Question Format"),
        (
            "**ALWAYS follow this structure for every ask the user in chat call:**",
            "**ALWAYS follow this structure for every user question you ask in chat:**",
        ),
        ("One issue = one ask the user in chat call.", "One issue = one user question in chat."),
        ("Do NOT use ask the user in chat", "Do NOT ask the user in chat"),
        ("Skip ask the user in chat", "Skip asking the user in chat"),
        ("call ask the user in chat", "ask the user in chat"),
        ("use ask the user in chat", "ask the user in chat"),
        ("one ask the user in chat", "one user question in chat"),
        ("individual ask the user in chat", "individual user question in chat"),
        ("ask the user in chat calls", "user-question prompts"),
        (
            "ask the user in chat to confirm the eval scope with the user.",
            "ask the user to confirm the eval scope.",
        ),
        ("/{skill-name}", "/skill:{skill-name}"),
        ("/{skill}", "/skill:{skill}"),
    ]

    for old, new in wording_replacements:
        updated = updated.replace(old, new)

    return updated


def remove_allowed_tools_frontmatter(text: str) -> str:
    if not text.startswith("---\n"):
        return text

    match = re.match(r"^---\n(.*?)\n---\n?", text, flags=re.DOTALL)
    if not match:
        return text

    frontmatter = match.group(1)
    body = text[match.end() :]

    lines = frontmatter.splitlines()
    kept: list[str] = []
    skipping_allowed_tools = False

    for line in lines:
        if not skipping_allowed_tools and line.strip() == "allowed-tools:":
            skipping_allowed_tools = True
            continue

        if skipping_allowed_tools:
            # Continue skipping YAML list entries for allowed-tools.
            if re.match(r"^\s*-\s+", line):
                continue
            # Eat one optional blank separator line after the list.
            if line.strip() == "":
                continue
            skipping_allowed_tools = False

        kept.append(line)

    updated = "\n".join(kept)
    updated = re.sub(r"\n{3,}", "\n\n", updated).strip("\n")
    return f"---\n{updated}\n---\n\n{body.lstrip()}"


def replace_skill_commands(text: str) -> str:
    for cmd in SKILL_COMMANDS:
        pattern = re.compile(
            rf"(^|[\s`\"'<(\[])/{re.escape(cmd)}(?=$|[\s`\"')>\].,:;!?])",
            flags=re.MULTILINE,
        )
        text = pattern.sub(rf"\1/skill:{cmd}", text)
    return text


def patch_port_readme(text: str, path: Path) -> str:
    """Add a Pi-native identity header to port/gstack/README.md."""
    try:
        rel = path.relative_to(PORT_DIR).as_posix()
    except ValueError:
        return text

    if rel != "README.md":
        return text

    updated = text

    if updated.startswith("# gstack\n"):
        updated = updated.replace(
            "# gstack\n",
            "# gstack (Pi-native port)\n\n"
            "> This is the Pi-native port of [garrytan/gstack](https://github.com/garrytan/gstack), "
            "maintained in [westn/gstack-pi-port](https://github.com/westn/gstack-pi-port).\n"
            ">\n"
            "> If you are using **pi**, install from this repo (not from `garrytan/gstack`).\n",
            1,
        )

    intro_line = (
        "Nine opinionated workflow skills for "
        "[pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). "
        "Plan review, code review, one-command shipping, browser automation, QA testing, "
        "and engineering retrospectives — all as slash commands."
    )
    if intro_line in updated and "## What changed from upstream" not in updated:
        updated = updated.replace(
            intro_line,
            intro_line
            + "\n\n## What changed from upstream\n\n"
            + "- Install flow points to `westn/gstack-pi-port`\n"
            + "- Paths use Pi locations (`~/.pi/agent/skills` and `.pi/skills`)\n"
            + "- Commands use `/skill:<name>`\n"
            + "- Context guidance references `AGENTS.md` (Pi-native; `CLAUDE.md` also works in pi)",
            1,
        )

    readme_replacements = [
        # Upstream renamed this skill to /design-review in 0.6.x.
        ("/skill:qa-design-review", "/skill:design-review"),
        # Polish lingering Claude-specific wording from upstream prose.
        ("Open pi and paste this. Claude does the rest.", "Open pi and paste this. The agent does the rest."),
        ("Open pi and paste this. Claude will do the rest.", "Open pi and paste this. The agent will do the rest."),
        ("**Claude says it can't see the skills?**", "**pi says it can't see the skills?**"),
        ("[Claude writes 2,400 lines across 11 files — models, services,", "[Agent writes 2,400 lines across 11 files — models, services,"),
    ]
    for old, new in readme_replacements:
        updated = updated.replace(old, new)

    return updated


def transform_text(text: str, path: Path) -> str:
    updated = text

    for old, new in PATH_REPLACEMENTS:
        updated = updated.replace(old, new)

    for old, new in REVIEW_PATH_REPLACEMENTS:
        updated = updated.replace(old, new)

    updated = replace_skill_commands(updated)

    for old, new in PHRASE_REPLACEMENTS:
        updated = updated.replace(old, new)

    is_doc_like = path.suffix == ".md" or path.name.endswith(".md.tmpl")
    if is_doc_like:
        for old, new in DOC_ONLY_PHRASE_REPLACEMENTS:
            updated = updated.replace(old, new)

    updated = normalize_pi_wording(updated)
    updated = patch_port_readme(updated, path)

    if path.suffix == ".md" or path.name == "SKILL.md":
        updated = remove_allowed_tools_frontmatter(updated)

    return updated


def is_probably_text(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return False

    try:
        data = path.read_bytes()
    except OSError:
        return False

    if b"\x00" in data:
        return False

    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False

    return True


def copy_upstream() -> None:
    if PORT_DIR.exists():
        shutil.rmtree(PORT_DIR)

    def ignore(_dir: str, names: list[str]) -> set[str]:
        ignored = {".git"} if ".git" in names else set()
        return ignored

    shutil.copytree(UPSTREAM_DIR, PORT_DIR, ignore=ignore)


def transform_port_tree() -> int:
    changed = 0
    for path in PORT_DIR.rglob("*"):
        if not path.is_file():
            continue
        if not is_probably_text(path):
            continue

        original = path.read_text(encoding="utf-8")
        updated = transform_text(original, path)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed += 1
    return changed


def apply_overrides() -> int:
    """Apply maintained Pi-specific overrides after mechanical transforms."""
    if not OVERRIDES_DIR.exists():
        return 0

    changed = 0
    for src in OVERRIDES_DIR.rglob("*"):
        if not src.is_file():
            continue

        rel = src.relative_to(OVERRIDES_DIR)
        dest = PORT_DIR / rel
        dest.parent.mkdir(parents=True, exist_ok=True)

        src_bytes = src.read_bytes()
        dest_bytes = dest.read_bytes() if dest.exists() else None
        if dest_bytes != src_bytes:
            dest.write_bytes(src_bytes)
            changed += 1

    return changed


def patch_env_example_for_pi() -> bool:
    path = PORT_DIR / ".env.example"
    if not path.exists():
        return False

    desired = (
        "# Copy to .env and fill in values\n"
        "# bun auto-loads .env — no dotenv needed\n\n"
        "# Optional: pin eval runner to a specific pi provider/model.\n"
        "# If unset, pi uses your default configured provider/model.\n"
        "PI_EVAL_PROVIDER=\n"
        "PI_EVAL_MODEL=\n"
        "PI_EVAL_THINKING=\n\n"
        "# Configure at least one provider API key supported by pi.\n"
        "# Examples (pick what you use):\n"
        "# OPENAI_API_KEY=...\n"
        "# GEMINI_API_KEY=...\n"
        "# OPENROUTER_API_KEY=...\n"
    )

    current = path.read_text(encoding="utf-8")
    if current == desired:
        return False

    path.write_text(desired, encoding="utf-8")
    return True


def patch_package_json_for_pi() -> bool:
    path = PORT_DIR / "package.json"
    if not path.exists():
        return False

    data = json.loads(path.read_text(encoding="utf-8"))
    changed = False

    dev = data.get("devDependencies")
    if isinstance(dev, dict) and "@anthropic-ai/sdk" in dev:
        dev.pop("@anthropic-ai/sdk", None)
        changed = True
        if not dev:
            data.pop("devDependencies", None)

    keywords = data.get("keywords")
    if isinstance(keywords, list):
        updated_keywords = ["pi" if kw == "claude" else kw for kw in keywords]
        if updated_keywords != keywords:
            data["keywords"] = updated_keywords
            changed = True

    if not changed:
        return False

    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return True


def ensure_agents_context_file() -> bool:
    """Mirror CLAUDE.md to AGENTS.md for Pi-native context file discoverability."""
    claude_path = PORT_DIR / "CLAUDE.md"
    agents_path = PORT_DIR / "AGENTS.md"

    if not claude_path.exists():
        return False

    content = claude_path.read_text(encoding="utf-8")
    if agents_path.exists():
        existing = agents_path.read_text(encoding="utf-8")
        if existing == content:
            return False

    agents_path.write_text(content, encoding="utf-8")
    return True


def read_required_version(path: Path) -> str:
    if not path.exists():
        raise RuntimeError(f"Missing required VERSION file: {path}")

    version = path.read_text(encoding="utf-8").strip()
    if not version:
        raise RuntimeError(f"Empty VERSION file: {path}")

    return version


def verify_version_parity() -> str:
    """Ensure the generated port keeps the exact upstream VERSION value."""
    upstream_version = read_required_version(UPSTREAM_DIR / "VERSION")
    port_version = read_required_version(PORT_DIR / "VERSION")

    if upstream_version != port_version:
        raise RuntimeError(
            "VERSION mismatch after sync: "
            f"upstream={upstream_version} port={port_version}. "
            "The port must mirror upstream VERSION."
        )

    return upstream_version


def verify_port_quality() -> None:
    """Fail fast on common mechanical-port regressions."""
    stale_phrases = [
        "## ask the user in chat Format",
        "every ask the user in chat call",
        "and tells pi that if gstack skills aren't working,",
        "/brainstorm",
        "https://claude.com/claude-code",
        "Skip ask the user in chat",
        "call ask the user in chat",
        "/{skill-name}",
        "/{skill}",
        # Contributor/eval harness should stay pi-native and model-agnostic.
        "claude -p",
        "Anthropic API",
        "ANTHROPIC_API_KEY",
        "@anthropic-ai/sdk",
        "claude-sonnet-4-6",
        "noreply@anthropic.com",
        "--output-format stream-json",
        "Spawn real Claude session",
    ]

    findings: list[str] = []
    bare_command_findings: list[str] = []

    for path in PORT_DIR.rglob("*"):
        if not path.is_file() or not is_probably_text(path):
            continue

        rel = path.relative_to(PORT_DIR).as_posix()
        content = path.read_text(encoding="utf-8")

        for phrase in stale_phrases:
            if phrase in content:
                findings.append(f"{rel}: contains stale phrase '{phrase}'")

        if rel == "README.md" and "/skill:qa-design-review" in content:
            findings.append(
                "README.md: contains stale '/skill:qa-design-review' reference "
                "(expected '/skill:design-review')"
            )

        for cmd in SKILL_COMMANDS:
            pattern = re.compile(
                rf"(^|[\s`\"'<(\[])/{re.escape(cmd)}(?=$|[\s`\"')>\].,:;!?])",
                flags=re.MULTILINE,
            )
            if pattern.search(content):
                bare_command_findings.append(f"{rel}: found '/{cmd}' (expected '/skill:{cmd}')")

    findings.extend(bare_command_findings)

    if findings:
        preview = "\n".join(f"- {item}" for item in findings[:20])
        more = ""
        if len(findings) > 20:
            more = f"\n... and {len(findings) - 20} more"
        raise RuntimeError(
            "Port quality checks failed:\n"
            f"{preview}{more}\n"
            "Update transform rules to normalize these patterns."
        )


def write_metadata(changed_files: int) -> None:
    commit = run(["git", "rev-parse", "HEAD"], cwd=UPSTREAM_DIR)
    version_file = UPSTREAM_DIR / "VERSION"
    version = version_file.read_text(encoding="utf-8").strip() if version_file.exists() else "unknown"

    metadata = {
        "upstream": {
            "repo": UPSTREAM_REPO,
            "branch": UPSTREAM_BRANCH,
            "commit": commit,
            "version": version,
        },
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "portDir": str(PORT_DIR.relative_to(REPO_ROOT)),
        "changedFiles": changed_files,
        "transformRules": {
            "pathReplacements": PATH_REPLACEMENTS,
            "reviewPathReplacements": REVIEW_PATH_REPLACEMENTS,
            "phraseReplacements": PHRASE_REPLACEMENTS,
            "docOnlyPhraseReplacements": DOC_ONLY_PHRASE_REPLACEMENTS,
            "skillCommands": SKILL_COMMANDS,
            "removeAllowedTools": True,
            "overridesDir": str(OVERRIDES_DIR.relative_to(REPO_ROOT)) if OVERRIDES_DIR.exists() else None,
        },
    }

    METADATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    METADATA_PATH.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    global SKILL_COMMANDS

    ensure_upstream()
    SKILL_COMMANDS = discover_skill_commands()

    copy_upstream()
    changed_files = transform_port_tree()

    override_count = apply_overrides()
    changed_files += override_count

    if patch_env_example_for_pi():
        changed_files += 1

    if patch_package_json_for_pi():
        changed_files += 1

    if ensure_agents_context_file():
        changed_files += 1

    synced_version = verify_version_parity()
    verify_port_quality()
    write_metadata(changed_files)

    commit = run(["git", "rev-parse", "--short", "HEAD"], cwd=UPSTREAM_DIR)
    print(f"Synced upstream {UPSTREAM_REPO}@{commit}")
    print(f"Wrote port to {PORT_DIR}")
    print(f"Version parity check passed: {synced_version}")
    print(f"Port quality check passed ({len(SKILL_COMMANDS)} skill commands normalized)")
    print(f"Transformed {changed_files} files")
    print(f"Metadata: {METADATA_PATH}")


if __name__ == "__main__":
    main()
