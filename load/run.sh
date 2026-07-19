#!/usr/bin/env bash
#
# FlyTrace load-test runner.
#
# Runs a named scenario with a chosen profile and writes a k6 summary JSON to
# load/results/, named <scenario>-<profile>-<timestamp>.json so report.js can
# attribute each run. Everything else is passed through to k6 via -e flags.
#
# Usage:
#   load/run.sh <scenario> [profile] [-- <extra k6 args>]
#
#   scenario : api-burst | ws-connections | aircraft-stream
#   profile  : smoke | 1k | 5k | 10k | 50k-ws        (default: smoke)
#
# Env (forwarded to k6):
#   BASE_URL   HTTP base       (default http://localhost:3001)
#   WS_URL     WS base         (default derived from BASE_URL)
#   VUS        override VUs     (ws scenarios)
#
# Examples:
#   load/run.sh api-burst 1k
#   BASE_URL=http://api.local:3001 load/run.sh api-burst 10k
#   VUS=50000 load/run.sh ws-connections 50k-ws
#   load/run.sh aircraft-stream smoke -- --http-debug
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
SCENARIOS_DIR="${SCRIPT_DIR}/scenarios"

usage() {
  sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

SCENARIO="${1:-}"
[ -z "${SCENARIO}" ] && usage 1
[ "${SCENARIO}" = "-h" ] || [ "${SCENARIO}" = "--help" ] && usage 0
shift || true

PROFILE="smoke"
if [ "${1:-}" != "" ] && [ "${1:-}" != "--" ]; then
  PROFILE="$1"
  shift || true
fi

# Anything after `--` is forwarded verbatim to k6.
EXTRA=()
if [ "${1:-}" = "--" ]; then
  shift
  EXTRA=("$@")
fi

SCRIPT="${SCENARIOS_DIR}/${SCENARIO}.js"
if [ ! -f "${SCRIPT}" ]; then
  echo "error: unknown scenario '${SCENARIO}' (no ${SCRIPT})" >&2
  echo "available:" >&2
  ls -1 "${SCENARIOS_DIR}" | sed 's/\.js$//' | sed 's/^/  - /' >&2
  exit 1
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "error: k6 not found on PATH. See load/README.md for install steps." >&2
  exit 127
fi

mkdir -p "${RESULTS_DIR}"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="${RESULTS_DIR}/${SCENARIO}-${PROFILE}-${TS}.json"

echo "▶ scenario : ${SCENARIO}"
echo "▶ profile  : ${PROFILE}"
echo "▶ base url : ${BASE_URL:-http://localhost:3001}"
echo "▶ ws url   : ${WS_URL:-<derived>}"
echo "▶ vus      : ${VUS:-<profile default>}"
echo "▶ summary  : ${OUT}"
echo

# --summary-export writes the end-of-test aggregated metrics JSON that report.js
# consumes. PROFILE/VUS/urls are passed as k6 env (-e) so the scripts pick them up.
set -x
k6 run \
  -e "PROFILE=${PROFILE}" \
  ${BASE_URL:+-e "BASE_URL=${BASE_URL}"} \
  ${WS_URL:+-e "WS_URL=${WS_URL}"} \
  ${VUS:+-e "VUS=${VUS}"} \
  --summary-export="${OUT}" \
  "${EXTRA[@]}" \
  "${SCRIPT}"
set +x

echo
echo "✔ wrote ${OUT}"
echo "  build a consolidated report with:  node load/report.js"
