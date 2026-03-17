#!/usr/bin/env python3
"""Run an optional LLM-driven audit over the generated Pi port.

This is intentionally report-only. It does not edit files.

Usage:
  python scripts/llm_port_audit.py
  python scripts/llm_port_audit.py --target port/gstack --output port/LLM_PORT_AUDIT.md
"""

from __future__ import annotations

import argparse
import datetime as dt
import subprocess
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = REPO_ROOT / "port" / "gstack"
DEFAULT_OUTPUT = REPO_ROOT / "port" / "LLM_PORT_AUDIT.md"


def run_pi_audit(target: Path) -> str:
    prompt = textwrap.dedent(
        f"""
        You are auditing a Pi-native port of gstack.

        Target directory: {target}

        Task:
        - Look for porting artifacts and wording drift caused by mechanical transforms.
        - Focus on user-facing docs and SKILL instructions.
        - Validate that skill command references use /skill:<name> form.
        - Validate that legacy Claude-specific path references (.claude) are gone.
        - Flag awkward phrasing from mechanical replacement (for example malformed headings,
          unnatural grammar, or stale terminology).

        Important exclusions (do NOT flag these):
        - literal `claude -p` command usage in test harness/docs
        - model names that include "Claude"
        - "Co-Authored-By: Claude ..." git trailer examples

        Output format (Markdown):
        1) Executive summary (2-4 bullets)
        2) Findings table: Severity | File | Evidence | Why it matters | Suggested fix
        3) Transform rule recommendations (concrete replacements/regexes)
        4) Confidence + open questions

        Keep it concise and practical.
        """
    ).strip()

    cmd = [
        "pi",
        "--no-session",
        "--tools",
        "read,grep,find,ls",
        "-p",
        prompt,
    ]

    proc = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    if proc.returncode != 0:
        raise RuntimeError(
            "pi audit failed. Ensure pi is installed/authenticated.\n"
            f"Command: {' '.join(cmd)}\n"
            f"stderr:\n{proc.stderr.strip()}"
        )

    output = proc.stdout.strip()
    if not output:
        raise RuntimeError("pi audit produced empty output")

    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Run optional LLM audit on the generated port")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET, help="Directory to audit")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Markdown report path")
    args = parser.parse_args()

    target = args.target
    if not target.is_absolute():
        target = (REPO_ROOT / target).resolve()

    if not target.exists() or not target.is_dir():
        raise RuntimeError(f"Target directory does not exist: {target}")

    report = run_pi_audit(target)

    out = args.output
    if not out.is_absolute():
        out = (REPO_ROOT / out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    header = (
        f"# LLM Port Audit\n\n"
        f"- Generated: {dt.datetime.now(dt.timezone.utc).isoformat()}\n"
        f"- Target: `{target}`\n\n"
    )
    out.write_text(header + report + "\n", encoding="utf-8")

    print(f"Wrote audit report: {out}")


if __name__ == "__main__":
    main()
