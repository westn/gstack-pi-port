#!/usr/bin/env python3
"""Pi port health/status checks for gstack-pi-port.

Inspired by adapter-style ports that expose a runtime status command, this script
keeps the static Pi port honest: it validates the synced upstream snapshot,
critical Pi-native transforms, generated skill surface, install freshness, and
optional upstream freshness in one machine-readable status pass.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PORT_DIR = REPO_ROOT / "port" / "gstack"
UPSTREAM_DIR = REPO_ROOT / ".upstream" / "gstack"
METADATA_PATH = REPO_ROOT / "port" / "METADATA.json"
GLOBAL_INSTALL = Path.home() / ".pi" / "agent" / "skills" / "gstack"

CRITICAL_SKILLS = {
    "autoplan",
    "browse",
    "careful",
    "codex",
    "design-review",
    "freeze",
    "gstack-upgrade",
    "guard",
    "investigate",
    "office-hours",
    "open-gstack-browser",
    "plan-ceo-review",
    "plan-design-review",
    "plan-devex-review",
    "plan-eng-review",
    "qa",
    "qa-only",
    "review",
    "ship",
    "unfreeze",
}

# These phrases are expected in the dedicated upgrade skill, but should not leak
# into regular generated skills or docs.
REGULAR_SKILL_FORBIDDEN = {
    "~/.claude/skills",
    ".claude/skills",
    "claude -p",
    "ANTHROPIC_API_KEY",
    "@anthropic-ai/sdk",
    "/brainstorm",
    "connect-chrome",
}

ROOT_SKILL_FORBIDDEN = {
    "git rm -r",
    "gstack-team-init",
    "~/.claude/skills",
    ".claude/skills",
}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def run(cmd: list[str], cwd: Path | None = None) -> str:
    return subprocess.check_output(cmd, cwd=cwd, text=True).strip()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_version(path: Path) -> str:
    version_path = path / "VERSION"
    return read_text(version_path).strip() if version_path.exists() else "missing"


def list_skill_names() -> list[str]:
    if not PORT_DIR.exists():
        return []
    names: list[str] = []
    for skill_md in PORT_DIR.glob("*/SKILL.md"):
        names.append(skill_md.parent.name)
    if (PORT_DIR / "SKILL.md").exists():
        names.append("gstack")
    return sorted(names)


def load_metadata() -> dict:
    if not METADATA_PATH.exists():
        return {}
    return json.loads(read_text(METADATA_PATH))


def check_version_parity() -> Check:
    port = read_version(PORT_DIR)
    upstream = read_version(UPSTREAM_DIR)
    return Check("version parity", port == upstream and port != "missing", f"port={port} upstream={upstream}")


def check_metadata() -> Check:
    metadata = load_metadata()
    meta_version = metadata.get("upstream", {}).get("version")
    meta_commit = metadata.get("upstream", {}).get("commit")
    port_version = read_version(PORT_DIR)
    try:
        upstream_commit = run(["git", "rev-parse", "HEAD"], cwd=UPSTREAM_DIR)
    except Exception:
        upstream_commit = "unknown"
    ok = meta_version == port_version and meta_commit == upstream_commit and bool(meta_commit)
    return Check("metadata", ok, f"version={meta_version} commit={str(meta_commit)[:12]} upstream_head={upstream_commit[:12]}")


def check_skill_surface() -> Check:
    names = set(list_skill_names())
    missing = sorted(CRITICAL_SKILLS - names)
    ok = len(names) >= 40 and not missing
    detail = f"skills={len(names)}"
    if missing:
        detail += f" missing={','.join(missing)}"
    return Check("skill surface", ok, detail)


def check_regular_skill_porting() -> Check:
    findings: list[str] = []
    for skill_md in PORT_DIR.glob("*/SKILL.md"):
        rel = skill_md.relative_to(PORT_DIR).as_posix()
        if rel == "gstack-upgrade/SKILL.md":
            continue
        text = read_text(skill_md)
        for phrase in sorted(REGULAR_SKILL_FORBIDDEN):
            if phrase in text:
                findings.append(f"{rel}: {phrase}")
                break
    root = PORT_DIR / "SKILL.md"
    if root.exists():
        text = read_text(root)
        for phrase in sorted(ROOT_SKILL_FORBIDDEN):
            if phrase in text:
                findings.append(f"SKILL.md: {phrase}")
    ok = not findings
    detail = "no stale regular-skill phrases" if ok else "; ".join(findings[:8])
    if len(findings) > 8:
        detail += f"; ... +{len(findings) - 8} more"
    return Check("Pi-native skill text", ok, detail)


def check_host_registry() -> Check:
    host_index = PORT_DIR / "hosts" / "index.ts"
    setup = PORT_DIR / "setup"
    if not host_index.exists() or not setup.exists():
        return Check("host registry", False, "missing hosts/index.ts or setup")
    host_text = read_text(host_index)
    setup_text = read_text(setup)
    required = ["pi", "codex", "factory", "opencode", "hermes", "gbrain"]
    missing = [h for h in required if h not in host_text]
    ok = not missing and 'HOST="pi"' in setup_text and "pi|claude|codex|kiro|factory|opencode|auto" in setup_text
    detail = "pi primary + external hosts present" if ok else f"missing={missing} setup_pi={'HOST=\"pi\"' in setup_text}"
    return Check("host registry", ok, detail)


def check_installed_global() -> Check:
    if not GLOBAL_INSTALL.exists():
        return Check("global install", True, "not installed (ok for CI)")
    installed = read_version(GLOBAL_INSTALL)
    port = read_version(PORT_DIR)
    return Check("global install", installed == port, f"installed={installed} port={port}")


def check_upstream_remote(timeout: int) -> Check:
    metadata = load_metadata()
    current = metadata.get("upstream", {}).get("commit")
    if not current:
        return Check("upstream remote", False, "metadata has no upstream commit")
    url = "https://api.github.com/repos/garrytan/gstack/commits/main"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest = data.get("sha")
    except Exception as exc:
        return Check("upstream remote", False, f"could not query upstream: {exc}")
    return Check("upstream remote", latest == current, f"current={current[:12]} latest={str(latest)[:12]}")


def render(checks: list[Check], as_json: bool) -> None:
    if as_json:
        print(json.dumps({"ok": all(c.ok for c in checks), "checks": [c.__dict__ for c in checks]}, indent=2))
        return

    print("gstack-pi-port health")
    print("=" * 22)
    for check in checks:
        mark = "PASS" if check.ok else "FAIL"
        print(f"{mark:4}  {check.name:22} {check.detail}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--check-upstream", action="store_true", help="query GitHub and verify metadata is at upstream main")
    parser.add_argument("--timeout", type=int, default=20, help="network timeout for --check-upstream")
    args = parser.parse_args(argv)

    checks = [
        check_version_parity(),
        check_metadata(),
        check_skill_surface(),
        check_regular_skill_porting(),
        check_host_registry(),
        check_installed_global(),
    ]
    if args.check_upstream:
        checks.append(check_upstream_remote(args.timeout))

    render(checks, args.json)
    return 0 if all(c.ok for c in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
