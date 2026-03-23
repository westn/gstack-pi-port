#!/usr/bin/env python3
"""Check whether the repo's tracked pi-mono release is up to date.

This script compares PI_MONO_RELEASE (repo baseline) against the latest
release from https://github.com/badlogic/pi-mono/releases.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOCK_FILE = REPO_ROOT / "PI_MONO_RELEASE"
LATEST_RELEASE_API = "https://api.github.com/repos/badlogic/pi-mono/releases/latest"


def read_tracked_tag(lock_file: Path) -> str:
    if not lock_file.exists():
        return ""

    for line in lock_file.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        return s.split()[0]

    return ""


def fetch_latest_release(timeout: float) -> dict[str, str]:
    req = urllib.request.Request(
        LATEST_RELEASE_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "gstack-pi-port/pi-mono-release-check",
        },
    )

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)

    return {
        "tag": data.get("tag_name", ""),
        "name": data.get("name", ""),
        "published_at": data.get("published_at", ""),
        "url": data.get("html_url", "https://github.com/badlogic/pi-mono/releases"),
    }


def write_lock_file(lock_file: Path, tag: str) -> None:
    content = (
        "# Reviewed badlogic/pi-mono release tag used as update baseline.\n"
        "# Update with: python3 scripts/check_pi_mono_release.py --write-lock\n"
        f"{tag}\n"
    )
    lock_file.write_text(content, encoding="utf-8")


def emit_json(payload: dict) -> None:
    print(json.dumps(payload, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-lock", action="store_true", help="Update PI_MONO_RELEASE to latest tag")
    parser.add_argument("--allow-stale", action="store_true", help="Exit 0 even when baseline is stale")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Print machine-readable JSON")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds (default: 20)")
    parser.add_argument("--lock-file", type=Path, default=DEFAULT_LOCK_FILE, help="Path to lock file")
    args = parser.parse_args()

    tracked_tag = read_tracked_tag(args.lock_file)

    try:
        latest = fetch_latest_release(timeout=args.timeout)
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        msg = f"Failed to fetch latest pi-mono release: {exc}"
        payload = {
            "ok": False,
            "error": msg,
            "tracked_tag": tracked_tag,
            "lock_file": str(args.lock_file),
        }
        if args.as_json:
            emit_json(payload)
        else:
            print(msg, file=sys.stderr)
            print("Tip: rerun with --allow-stale to continue without blocking.", file=sys.stderr)

        return 0 if args.allow_stale else 2

    latest_tag = latest["tag"]
    if not latest_tag:
        msg = "GitHub API returned an empty tag_name for badlogic/pi-mono latest release"
        if args.as_json:
            emit_json({"ok": False, "error": msg, "tracked_tag": tracked_tag})
        else:
            print(msg, file=sys.stderr)
        return 2

    if args.write_lock:
        args.lock_file.parent.mkdir(parents=True, exist_ok=True)
        write_lock_file(args.lock_file, latest_tag)

    is_current = tracked_tag == latest_tag if tracked_tag else False
    if args.write_lock:
        is_current = True
        tracked_tag = latest_tag

    payload = {
        "ok": is_current,
        "tracked_tag": tracked_tag,
        "latest_tag": latest_tag,
        "latest_published_at": latest["published_at"],
        "latest_url": latest["url"],
        "lock_file": str(args.lock_file),
        "write_lock": args.write_lock,
    }

    if args.as_json:
        emit_json(payload)
    else:
        if is_current:
            print(
                f"pi-mono release baseline is current: {latest_tag} "
                f"({latest['published_at'] or 'unknown publish date'})"
            )
        else:
            if tracked_tag:
                print(
                    f"pi-mono release baseline is stale: tracked={tracked_tag}, latest={latest_tag}",
                    file=sys.stderr,
                )
            else:
                print("pi-mono release baseline is missing (PI_MONO_RELEASE is empty or absent).", file=sys.stderr)

            print(f"Latest release: {latest['url']}", file=sys.stderr)
            print(
                "Review release notes, update compatibility if needed, then run:\n"
                "  python3 scripts/check_pi_mono_release.py --write-lock",
                file=sys.stderr,
            )

    if is_current or args.allow_stale:
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
