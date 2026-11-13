#!/usr/bin/env bash
# EVAL ONLY (not for merge): runs the Jev exploration. Usage: jev-more.sh content|analyze|diet|fresh
set -u
cd "$(dirname "$0")/../../.."
OUT=${OUT:-$HOME/Programming/gloss/.eval-out/jev-more}
mkdir -p "$OUT"
ALL=${PRS:-"15721 16387 15755 16041 15946 15268 15798 gloss61"}
FRESH=${FRESH_PRS:-"15721 15755 15798 gloss61"}

ref() { if [ "$1" = gloss61 ]; then echo "brishin/gloss#61"; else echo "scuba-app/flashback#$1"; fi; }

# tour <name> <arm> <flags> [--force]: one tour, its JSON, stderr timeline and trace.
tour() {
  local n=$1 arm=$2 flags=$3
  shift 3
  local base="$OUT/$n-$arm"
  if [ -s "$base.json" ]; then return 0; fi
  GLOSS_EVAL_JEV=$flags GLOSS_EVAL_LOG=1 GLOSS_EVAL_TRACE="$base.trace.json" \
    node packages/cli/src/bin.ts tour "$(ref "$n")" --json "$@" >"$base.json" 2>"$base.stderr" || echo "FAIL $n $arm"
  echo "$n $arm: $(tail -1 "$base.stderr")"
}

content_one() { tour "$1" base ''; tour "$1" rk roomy,keyhint; }
analyze_one() {
  for mode in place diet precheck verify dedupe; do
    [ -s "$OUT/$1-$mode.json" ] && continue
    node packages/cli/experiments/jev-more.ts "$mode" --tour "$OUT/$1-base.json" --trace "$OUT/$1-base.trace.json" \
      --out "$OUT/$1-$mode.json" 2>>"$OUT/$1-analyze.stderr" || echo "FAIL $1 $mode"
  done
  echo "analyzed $1"
}
export -f tour ref content_one analyze_one
export OUT

case "${1:-}" in
  content) printf '%s\n' $ALL | xargs -P 3 -I{} bash -c 'content_one {}' ;;
  analyze) printf '%s\n' $ALL | xargs -P 2 -I{} bash -c 'analyze_one {}' ;;
  diet) printf '%s\n' $ALL | xargs -P 3 -I{} bash -c 'tour {} diet diet' ;;
  fresh)
    # One tour at a time, arms back to back, so each pair shares a time window.
    for round in 1 2; do
      for n in $FRESH; do
        tour "$n" "f$round-base" '' --force
        tour "$n" "f$round-fast" early,roomy,keyhint,jevplace --force
      done
    done
    for n in $FRESH; do tour "$n" f1-fastdiet early,roomy,keyhint,jevplace,diet --force; done
    ;;
  *) echo "Usage: jev-more.sh content|analyze|diet|fresh" && exit 1 ;;
esac
echo "DONE ${1:-}"
