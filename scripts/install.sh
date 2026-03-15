#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/port/gstack"

TARGET=""
RUN_BUILD=0

usage() {
  cat <<'EOF'
Install the generated gstack-for-pi port.

Usage:
  scripts/install.sh [--global] [--project <dir>] [--target <path>] [--build]

Options:
  --global           Install to ~/.pi/agent/skills/gstack (default)
  --project <dir>    Install to <dir>/.pi/skills/gstack
  --target <path>    Install to an explicit path
  --build            Run upstream ./setup after install (build browse binary)
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global)
      TARGET="$HOME/.pi/agent/skills/gstack"
      shift
      ;;
    --project)
      [[ $# -ge 2 ]] || { echo "--project requires a path" >&2; exit 1; }
      TARGET="$2/.pi/skills/gstack"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || { echo "--target requires a path" >&2; exit 1; }
      TARGET="$2"
      shift 2
      ;;
    --build)
      RUN_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  TARGET="$HOME/.pi/agent/skills/gstack"
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Port output missing: $SOURCE_DIR" >&2
  echo "Run scripts/sync_from_upstream.py first." >&2
  exit 1
fi

SKILLS_DIR="$(dirname "$TARGET")"
TARGET_BASENAME="$(basename "$TARGET")"

if [[ "$TARGET_BASENAME" != "gstack" ]]; then
  echo "Warning: target basename is '$TARGET_BASENAME' (recommended: 'gstack' to match skill name)." >&2
fi

mkdir -p "$SKILLS_DIR"
rm -rf "$TARGET"
cp -a "$SOURCE_DIR" "$TARGET"

echo "Installed gstack port to: $TARGET"

# pi discovery behavior: if a directory contains SKILL.md, recursion stops there.
# Create top-level symlinks so each gstack sub-skill appears as an individual skill.
linked=()
for skill_dir in "$TARGET"/*/; do
  [[ -d "$skill_dir" ]] || continue
  [[ -f "$skill_dir/SKILL.md" ]] || continue
  skill_name="$(basename "$skill_dir")"
  [[ "$skill_name" == "node_modules" ]] && continue

  target_link="$SKILLS_DIR/$skill_name"
  ln -snf "$TARGET_BASENAME/$skill_name" "$target_link"
  linked+=("$skill_name")
done

if [[ ${#linked[@]} -gt 0 ]]; then
  echo "Linked sub-skills: ${linked[*]}"
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  if [[ -x "$TARGET/setup" ]]; then
    echo "Running setup (builds browse binary and dependencies)..."
    (cd "$TARGET" && ./setup)
  else
    echo "No setup script found at $TARGET/setup"
  fi
fi

cat <<EOF

Done.

Use skills in pi as:
  /skill:plan-ceo-review
  /skill:plan-eng-review
  /skill:review
  /skill:ship
  /skill:browse
  /skill:qa
  /skill:setup-browser-cookies
  /skill:retro

If skills do not appear immediately, run /reload inside pi.
Use --build when you want to compile browse binary/deps:
  ./scripts/install.sh --global --build
EOF
