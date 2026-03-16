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

UPSTREAM_REPO = "https://github.com/garrytan/gstack.git"
UPSTREAM_BRANCH = "main"

SKILL_COMMANDS = [
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
]

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
]

PHRASE_REPLACEMENTS = [
    ("AskUserQuestion", "ask the user in chat"),
    ("Claude Code", "pi"),
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
            rf"(^|[\s`\"'<(])/{re.escape(cmd)}(?=$|[\s`\"')>.,:;!?])",
            flags=re.MULTILINE,
        )
        text = pattern.sub(rf"\1/skill:{cmd}", text)
    return text


def transform_text(text: str, path: Path) -> str:
    updated = text

    for old, new in PATH_REPLACEMENTS:
        updated = updated.replace(old, new)

    for old, new in REVIEW_PATH_REPLACEMENTS:
        updated = updated.replace(old, new)

    updated = replace_skill_commands(updated)

    for old, new in PHRASE_REPLACEMENTS:
        updated = updated.replace(old, new)

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
            "skillCommands": SKILL_COMMANDS,
            "removeAllowedTools": True,
        },
    }

    METADATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    METADATA_PATH.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ensure_upstream()
    copy_upstream()
    changed_files = transform_port_tree()
    write_metadata(changed_files)

    commit = run(["git", "rev-parse", "--short", "HEAD"], cwd=UPSTREAM_DIR)
    print(f"Synced upstream {UPSTREAM_REPO}@{commit}")
    print(f"Wrote port to {PORT_DIR}")
    print(f"Transformed {changed_files} files")
    print(f"Metadata: {METADATA_PATH}")


if __name__ == "__main__":
    main()
