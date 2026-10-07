#!/usr/bin/env bash
# =============================================================================
# EUDIPLO k6 Load Test Runner
# =============================================================================
#
# Runs one or more k6 load test scenarios against an EUDIPLO backend.
#
# Usage:
#   ./run-all.sh [--once] [--external] [scenario...]
#
#   If no scenario is specified all scenarios are run in sequence.
#   Available scenarios: api-auth, pre-auth-issuance, oid4vp-presentation, status-list
#   --once forces K6_PROFILE=once and PAUSE_BETWEEN=0 for fast feedback.
#
# Environment variables:
#   BASE_URL            Backend base URL          (default: http://localhost:3000)
#   HEALTH_URL          Readiness endpoint        (default: BASE_URL/health)
#   SKIP_HEALTH_CHECK   Skip readiness probe      (default: false)
#   TENANT_ID           Issuer / verifier tenant  (default: demo)
#   CLIENT_ID           OAuth2 client ID          (default: test-client)
#   CLIENT_SECRET       OAuth2 client secret      (default: test-client-secret)
#   START_STACK         Auto-start compose stack  (default: true)
#   COMPOSE_PROFILE     Compose profile to start   (default: standard)
#   K6_ENV_FILE         Compose env file path      (default:
#                         deployment/docker-compose/k6.env, which imports the
#                         demo tenant; relative paths are resolved against the
#                         current directory)
#   K6_PROFILE          Load profile              (default: smoke)
#                         once | smoke | load | stress | spike
#   PROMETHEUS_RW_URL   If set, metrics are pushed to this Prometheus remote-
#                         write endpoint in addition to stdout.
#                         Example: http://localhost:9090/api/v1/write
#   SUMMARY_DIR         Directory for JSON summaries (default: ./results)
#   CLEAN_RESULTS       Delete SUMMARY_DIR before running (default: true)
#   PAUSE_BETWEEN       Seconds to pause between scenarios (default: 5)
#
# Examples:
#   # Smoke test all scenarios
#   ./run-all.sh
#
#   # Fast one-pass validation of all scenarios
#   ./run-all.sh --once
#
#   # Test an already-running self-hosted deployment
#   BASE_URL=https://issuer.example.com ./run-all.sh --external --once
#
#   # Load test pre-auth issuance only
#   K6_PROFILE=load ./run-all.sh pre-auth-issuance
#
#   # Stress test with Prometheus output
#   K6_PROFILE=stress PROMETHEUS_RW_URL=http://localhost:9090/api/v1/write \
#     ./run-all.sh pre-auth-issuance oid4vp-presentation
#
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve script directory so the script works regardless of where it is
# called from.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIOS_DIR="${SCRIPT_DIR}/scenarios"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_DIR="${REPO_ROOT}/deployment/docker-compose"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
BASE_URL="${BASE_URL:-http://localhost:3000}"
HEALTH_URL="${HEALTH_URL:-}"
SKIP_HEALTH_CHECK="${SKIP_HEALTH_CHECK:-false}"
TENANT_ID="${TENANT_ID:-demo}"
CLIENT_ID="${CLIENT_ID:-test-client}"
CLIENT_SECRET="${CLIENT_SECRET:-test-client-secret}"
START_STACK="${START_STACK:-true}"
COMPOSE_PROFILE="${COMPOSE_PROFILE:-standard}"
K6_ENV_FILE="${K6_ENV_FILE:-${COMPOSE_DIR}/k6.env}"
K6_PROFILE="${K6_PROFILE:-smoke}"
SUMMARY_DIR="${SUMMARY_DIR:-${SCRIPT_DIR}/results}"
CLEAN_RESULTS="${CLEAN_RESULTS:-true}"
PAUSE_BETWEEN="${PAUSE_BETWEEN:-5}"

# The stack is started from COMPOSE_DIR, so resolve a relative env file against
# the caller's directory first.
if [[ "${K6_ENV_FILE}" != /* ]]; then
    K6_ENV_FILE="${PWD}/${K6_ENV_FILE}"
fi

ALL_SCENARIOS=(api-auth pre-auth-issuance oid4vp-presentation status-list)

# ---------------------------------------------------------------------------
# Optional flags
# ---------------------------------------------------------------------------
FORCE_ONCE=false
EXTERNAL_TARGET=false
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --once)
            FORCE_ONCE=true
            shift
            ;;
        --external)
            EXTERNAL_TARGET=true
            START_STACK=false
            shift
            ;;
        --help|-h)
            sed -n '1,60p' "$0"
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

BASE_URL="${BASE_URL%/}"
if [[ ! "${BASE_URL}" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "ERROR: BASE_URL must be an absolute http(s) URL: ${BASE_URL}" >&2
    exit 1
fi
HEALTH_URL="${HEALTH_URL:-${BASE_URL}/health}"

if [[ "${EXTERNAL_TARGET}" == "true" && "${BASE_URL}" == "http://localhost:3000" ]]; then
    echo "ERROR: --external requires an explicit BASE_URL for the self-hosted deployment." >&2
    exit 1
fi

case "${SKIP_HEALTH_CHECK}" in
    true|false) ;;
    *)
        echo "ERROR: SKIP_HEALTH_CHECK must be 'true' or 'false'." >&2
        exit 1
        ;;
esac

if [[ "${FORCE_ONCE}" == "true" ]]; then
    K6_PROFILE="once"
    PAUSE_BETWEEN="0"
fi

# ---------------------------------------------------------------------------
# Determine which scenarios to run
# ---------------------------------------------------------------------------
if [[ ${#POSITIONAL_ARGS[@]} -gt 0 ]]; then
    RUN_SCENARIOS=("${POSITIONAL_ARGS[@]}")
else
    RUN_SCENARIOS=("${ALL_SCENARIOS[@]}")
fi

# ---------------------------------------------------------------------------
# Validate scenario names
# ---------------------------------------------------------------------------
for scenario in "${RUN_SCENARIOS[@]}"; do
    script="${SCENARIOS_DIR}/${scenario}.ts"
    if [[ ! -f "${script}" ]]; then
        echo "ERROR: Unknown scenario '${scenario}'. Available: ${ALL_SCENARIOS[*]}" >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Check k6 is installed
# ---------------------------------------------------------------------------
if ! command -v k6 &>/dev/null; then
    echo "ERROR: k6 is not installed or not in PATH." >&2
    echo "  Install: https://k6.io/docs/get-started/installation/" >&2
    exit 1
fi

wait_for_backend() {
    local retries=60
    local interval=2
    if [[ "${SKIP_HEALTH_CHECK}" == "true" ]]; then
        echo "Skipping backend health check."
        return 0
    fi

    local health_url="${HEALTH_URL}"

    echo "Waiting for backend health at ${health_url}..."
    for ((i=1; i<=retries; i++)); do
        if curl -sf "${health_url}" >/dev/null 2>&1; then
            echo "Backend is healthy."
            return 0
        fi
        sleep "${interval}"
    done

    echo "ERROR: Backend did not become healthy in $((retries * interval))s" >&2
    return 1
}

ensure_backend_reachable_when_not_starting_stack() {
    if [[ "${START_STACK}" == "true" ]]; then
        return 0
    fi

    if [[ "${SKIP_HEALTH_CHECK}" == "true" ]]; then
        echo "Skipping backend health check."
        return 0
    fi

    local health_url="${HEALTH_URL}"
    if curl -sf "${health_url}" >/dev/null 2>&1; then
        return 0
    fi

    echo "ERROR: Backend is not reachable at ${health_url} and START_STACK=false" >&2
    echo "  Either start backend manually or run with START_STACK=true." >&2
    return 1
}

start_stack_if_requested() {
    if [[ "${START_STACK}" != "true" ]]; then
        return 0
    fi

    if ! command -v docker &>/dev/null; then
        echo "ERROR: docker is required when START_STACK=true" >&2
        return 1
    fi

    if [[ ! -f "${K6_ENV_FILE}" ]]; then
        echo "ERROR: K6 env file not found: ${K6_ENV_FILE}" >&2
        return 1
    fi

    # If the backend is already healthy, reuse the running stack as-is.
    local health_url="${HEALTH_URL}"
    if curl -sf "${health_url}" >/dev/null 2>&1; then
        echo "Backend already healthy at ${health_url}, reusing existing stack."
        return 0
    fi

    echo "Starting compose stack (${COMPOSE_PROFILE}) using ${K6_ENV_FILE}"
    (
        cd "${COMPOSE_DIR}"
        docker compose --env-file "${K6_ENV_FILE}" --profile "${COMPOSE_PROFILE}" up -d
    )

    wait_for_backend
}

start_stack_if_requested
ensure_backend_reachable_when_not_starting_stack

# ---------------------------------------------------------------------------
# Create results directory
# ---------------------------------------------------------------------------
if [[ "${CLEAN_RESULTS}" == "true" && -d "${SUMMARY_DIR}" ]]; then
    rm -rf "${SUMMARY_DIR}"
fi
mkdir -p "${SUMMARY_DIR}"

# ---------------------------------------------------------------------------
# Run scenarios
# ---------------------------------------------------------------------------
FAILED_SCENARIOS=()
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"

run_scenario() {
    local scenario="$1"
    local script="${SCENARIOS_DIR}/${scenario}.ts"
    local summary_file="${SUMMARY_DIR}/${TIMESTAMP}-${scenario}.json"
    local log_file="${SUMMARY_DIR}/${TIMESTAMP}-${scenario}.log"

    echo ""
    echo "============================================================"
    echo "  Scenario : ${scenario}"
    echo "  Profile  : ${K6_PROFILE}"
    echo "  Target   : ${BASE_URL}"
    echo "  Summary  : ${summary_file}"
    echo "  Log      : ${log_file}"
    echo "============================================================"

    # Build k6 --out arguments
    local out_args=()
    if [[ -n "${PROMETHEUS_RW_URL:-}" ]]; then
        out_args+=(--out "experimental-prometheus-rw=${PROMETHEUS_RW_URL}")
    fi

    # Export variables for k6 scripts (__ENV)
    local env_args=(
        -e "BASE_URL=${BASE_URL}"
        -e "TENANT_ID=${TENANT_ID}"
        -e "CLIENT_ID=${CLIENT_ID}"
        -e "CLIENT_SECRET=${CLIENT_SECRET}"
        -e "K6_PROFILE=${K6_PROFILE}"
    )

    k6 run \
        "${env_args[@]}" \
        ${out_args[@]+"${out_args[@]}"} \
        --summary-export "${summary_file}" \
        "${script}" > "${log_file}" 2>&1
    local k6_exit=$?

    # Print the final summary block (last ~20 lines contain the k6 end-of-run table)
    tail -20 "${log_file}"

    if [[ "${k6_exit}" -eq 0 ]]; then
        echo "PASS: ${scenario}"
        return 0
    else
        echo "FAIL: ${scenario} (thresholds breached or error)"
        echo "  Full output: ${log_file}"
        return 1
    fi
}

for scenario in "${RUN_SCENARIOS[@]}"; do
    if ! run_scenario "${scenario}"; then
        FAILED_SCENARIOS+=("${scenario}")
    fi

    last_idx=$(( ${#RUN_SCENARIOS[@]} - 1 ))
    if [[ "${scenario}" != "${RUN_SCENARIOS[${last_idx}]}" ]]; then
        echo "Pausing ${PAUSE_BETWEEN}s before next scenario..."
        sleep "${PAUSE_BETWEEN}"
    fi
done

# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Load Test Summary"
echo "============================================================"
echo "  Ran      : ${#RUN_SCENARIOS[@]} scenario(s)"
echo "  Results  : ${SUMMARY_DIR}/"

if [[ ${#FAILED_SCENARIOS[@]} -eq 0 ]]; then
    echo "  Status   : ALL PASSED"
    exit 0
else
    echo "  FAILED   : ${FAILED_SCENARIOS[*]}"
    exit 1
fi
