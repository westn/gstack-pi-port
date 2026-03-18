#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

RUN_INSTALL=1
RUN_BUILD=0
RUN_TESTS=1
INSTALL_ARGS=(--global)

usage() {
  cat <<'EOF'
Update gstack-pi-port in one command.

Default behavior (full process):
  1) Sync from upstream
  2) Run sync/install script sanity checks
  3) Run Pi-native eval harness sanity tests
  4) Install globally to ~/.pi/agent/skills/gstack

Usage:
  scripts/update.sh [options]

Options:
  --no-install       Skip install step (repo update + verification only)
  --install          Force install step (default)
  --global           Install target: ~/.pi/agent/skills/gstack (default)
  --project <dir>    Install target: <dir>/.pi/skills/gstack
  --target <path>    Install target: explicit path
  --build            Run install with --build (compile browse binary/deps)
  --skip-tests       Skip sanity test step
  -h, --help         Show this help

Examples:
  scripts/update.sh
  scripts/update.sh --no-install
  scripts/update.sh --build
  scripts/update.sh --project /path/to/repo --build
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install)
      RUN_INSTALL=0
      shift
      ;;
    --install)
      RUN_INSTALL=1
      shift
      ;;
    --global)
      INSTALL_ARGS=(--global)
      RUN_INSTALL=1
      shift
      ;;
    --project)
      [[ $# -ge 2 ]] || { echo "--project requires a path" >&2; exit 1; }
      INSTALL_ARGS=(--project "$2")
      RUN_INSTALL=1
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || { echo "--target requires a path" >&2; exit 1; }
      INSTALL_ARGS=(--target "$2")
      RUN_INSTALL=1
      shift 2
      ;;
    --build)
      RUN_BUILD=1
      RUN_INSTALL=1
      shift
      ;;
    --skip-tests)
      RUN_TESTS=0
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

if [[ "$RUN_BUILD" -eq 1 && "$RUN_INSTALL" -eq 0 ]]; then
  echo "--build requires install step (remove --no-install)" >&2
  exit 1
fi

echo "[1/4] Syncing from upstream..."
python3 "$ROOT_DIR/scripts/sync_from_upstream.py"

echo "[2/4] Verifying local update tooling..."
python3 -m py_compile "$ROOT_DIR/scripts/sync_from_upstream.py"
bash -n "$ROOT_DIR/scripts/install.sh"

if [[ "$RUN_TESTS" -eq 1 ]]; then
  if command -v bun >/dev/null 2>&1; then
    echo "[3/4] Running Pi-native harness sanity tests..."
    (
      cd "$ROOT_DIR/port/gstack"
      bun test test/helpers/session-runner.test.ts test/helpers/observability.test.ts test/touchfiles.test.ts
    )
  else
    echo "[3/4] Skipping sanity tests (bun not found on PATH)."
  fi
else
  echo "[3/4] Skipping sanity tests (--skip-tests)."
fi

if [[ "$RUN_INSTALL" -eq 1 ]]; then
  echo "[4/4] Installing updated port..."
  install_cmd=("$ROOT_DIR/scripts/install.sh" "${INSTALL_ARGS[@]}")
  if [[ "$RUN_BUILD" -eq 1 ]]; then
    install_cmd+=(--build)
  fi
  "${install_cmd[@]}"
else
  echo "[4/4] Install skipped (--no-install)."
  echo "      To install later: ./scripts/install.sh --global"
fi

echo
echo "Update complete."
