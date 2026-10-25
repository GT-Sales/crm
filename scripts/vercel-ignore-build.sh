#!/usr/bin/env bash
# Compatibility wrapper. The shared selector anchors paths at the repo root.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "$script_dir/affected-builds.mjs" --vercel "${1:?app name required}"
