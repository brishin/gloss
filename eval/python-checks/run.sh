#!/usr/bin/env bash
# Eval-only: runs each PR's tour under four notes-prompt arms. The base arm runs first so the
# define/followup/Jev results are cached and shared; only the notes pass differs between arms.
#   eval/python-checks/run.sh 15756 15819 ...
set -u
cd "$(dirname "$0")/../.."
export OUT=${OUT:-$HOME/gloss-eval/python-checks}
mkdir -p "$OUT"
run() {
  local pr=$1 arm=$2
  [ -s "$OUT/$pr-$arm.json" ] && return 0
  GLOSS_EVAL_CHECKS=$arm node packages/cli/src/bin.ts tour "scuba-app/flashback#$pr" --json >"$OUT/$pr-$arm.json" 2>"$OUT/$pr-$arm.log" || echo "FAIL $pr $arm"
}
one() {
  local pr=$1
  run "$pr" base
  for arm in ${ARMS:-base2 specific general}; do run "$pr" "$arm" & done
  wait
  echo "done $pr"
}
export -f run one
printf '%s\n' "$@" | xargs -P "${JOBS:-3}" -I{} bash -c 'one {}'
