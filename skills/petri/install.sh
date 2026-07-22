#!/usr/bin/env bash
# Install Petri operator skill for local coding agents (Claude Code / Grok).
# Usage:
#   ./skills/petri/install.sh           # symlink into ~/.claude/skills and ~/.grok/skills
#   ./skills/petri/install.sh --copy    # copy instead of symlink
#   ./skills/petri/install.sh --claude-only | --grok-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR"
NAME="petri"
MODE="symlink"
TARGETS=()

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) MODE="copy"; shift ;;
    --symlink) MODE="symlink"; shift ;;
    --claude-only) TARGETS+=("$HOME/.claude/skills/$NAME"); shift ;;
    --grok-only) TARGETS+=("$HOME/.grok/skills/$NAME"); shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(
    "$HOME/.claude/skills/$NAME"
    "$HOME/.grok/skills/$NAME"
  )
fi

if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "error: SKILL.md not found at $SKILL_SRC" >&2
  exit 1
fi

for dest in "${TARGETS[@]}"; do
  parent="$(dirname "$dest")"
  mkdir -p "$parent"
  if [[ -e "$dest" || -L "$dest" ]]; then
    rm -rf "$dest"
  fi
  if [[ "$MODE" == "copy" ]]; then
    cp -R "$SKILL_SRC" "$dest"
    # do not copy install.sh into agent tree as required — keep it; agents ignore it
    echo "copied → $dest"
  else
    ln -s "$SKILL_SRC" "$dest"
    echo "linked → $dest"
  fi
done

echo "done. Skill name: /$NAME"
echo "  Claude: reload skills / new session if needed"
echo "  Grok:   /skills petri or wait for auto-reload"
