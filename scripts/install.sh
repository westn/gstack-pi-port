#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/port/gstack"

TARGET=""
RUN_BUILD=0
PRESERVE_BROWSE_DIST=0
BROWSE_DIST_BACKUP=""

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

# If we're not rebuilding, preserve an existing browse/dist so updates don't
# temporarily remove the binary until the next setup run.
if [[ "$RUN_BUILD" -eq 0 && -d "$TARGET/browse/dist" ]]; then
  BROWSE_DIST_BACKUP="$(mktemp -d)"
  cp -a "$TARGET/browse/dist" "$BROWSE_DIST_BACKUP/dist"
  PRESERVE_BROWSE_DIST=1
fi

rm -rf "$TARGET"
cp -a "$SOURCE_DIR" "$TARGET"

if [[ "$PRESERVE_BROWSE_DIST" -eq 1 && -d "$BROWSE_DIST_BACKUP/dist" ]]; then
  mkdir -p "$TARGET/browse"
  rm -rf "$TARGET/browse/dist"
  cp -a "$BROWSE_DIST_BACKUP/dist" "$TARGET/browse/dist"
  rm -rf "$BROWSE_DIST_BACKUP"
  echo "Preserved existing browse/dist (run --build to rebuild against latest source)."
fi

echo "Installed gstack port to: $TARGET"

# pi discovery behavior: if a directory contains SKILL.md, recursion stops there.
# Create top-level symlinks so each gstack sub-skill appears as an individual skill.
linked=()
removed=()

# Clean stale links from previous installs (for renamed/removed skills).
for existing in "$SKILLS_DIR"/*; do
  [[ -L "$existing" ]] || continue
  link_name="$(basename "$existing")"
  link_target="$(readlink "$existing" || true)"

  case "$link_target" in
    "$TARGET_BASENAME"/*)
      target_name="$(basename "$link_target")"

      # Remove stale links for deleted/renamed skills.
      if [[ ! -e "$SKILLS_DIR/$link_target" ]]; then
        rm -f "$existing"
        removed+=("$link_name")
        continue
      fi

      # Clean up legacy prefixed aliases (gstack-foo -> gstack/foo) while
      # preserving real skill names like gstack-upgrade -> gstack/gstack-upgrade.
      if [[ "$link_name" == gstack-* && "$link_name" != "$target_name" ]]; then
        rm -f "$existing"
        removed+=("$link_name")
      fi
      ;;
  esac
done

for skill_dir in "$TARGET"/*/; do
  [[ -d "$skill_dir" ]] || continue
  [[ -f "$skill_dir/SKILL.md" ]] || continue
  skill_name="$(basename "$skill_dir")"
  [[ "$skill_name" == "node_modules" ]] && continue

  target_link="$SKILLS_DIR/$skill_name"
  ln -snf "$TARGET_BASENAME/$skill_name" "$target_link"
  linked+=("$skill_name")
done

if [[ ${#removed[@]} -gt 0 ]]; then
  echo "Removed stale sub-skill links: ${removed[*]}"
fi

if [[ ${#linked[@]} -gt 0 ]]; then
  echo "Linked sub-skills: ${linked[*]}"
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  if [[ -x "$TARGET/setup" ]]; then
    echo "Running setup (builds browse binary and dependencies)..."
    # Force Claude-host install semantics but keep pi-friendly flat skill names.
    (cd "$TARGET" && ./setup --host claude --no-prefix)
  else
    echo "No setup script found at $TARGET/setup"
  fi
fi

echo
echo "Done."
echo

if [[ ${#linked[@]} -gt 0 ]]; then
  echo "Use skills in pi as:"
  for skill_name in "${linked[@]}"; do
    echo "  /skill:$skill_name"
  done
  echo
fi

echo "If skills do not appear immediately, run /reload inside pi."
echo "Use --build when you want to compile browse binary/deps:"
echo "  ./scripts/install.sh --global --build"
