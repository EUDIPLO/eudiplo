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
#   Available scenarios: api-auth, pre-auth-issuance, oid4vp-presentation,
#   status-list, mixed (all flows concurrently, the production-like workload)
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
#   SUMMARY_DIR         Directory for summaries and logs
#                         (default: scripts/load-test/results)
#   CLEAN_RESULTS       Delete SUMMARY_DIR before running (default: true)
#   PAUSE_BETWEEN       Seconds to pause between scenarios (default: 5)
#   LOADTEST_LIMITS     Apply compose.limits.yml (CPU/memory limits) when
#                         starting the stack (default: true)
#   RESOURCE_STATS      Sample `docker stats` and count backend log errors
#                         during each scenario (default: true when the target
#                         is the repository's compose stack, started by the
#                         runner or already running)
#   BASELINE_TOLERANCE  Allowed p95 increase over baseline.json (default: 0.2)
#   BASELINE_MIN_MS     Ignore p95 increases of at most this many ms (default: 5)
#   BASELINE_ENFORCE    Fail the run on a baseline regression (default: false)
#
# Scenario variables (THINK_TIME_MIN/MAX, REVOKE_RATIO, CREDENTIAL_POOL_SIZE,
# SEED_SESSIONS, MIXED_*_RATE, ...) are read by k6 from the environment; see
# the scenario files and apps/docs/docs/operate/load-testing.md.
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
#   # Production-like load on a database with 20 000 existing sessions
#   K6_PROFILE=load SEED_SESSIONS=20000 ./run-all.sh mixed
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
LOADTEST_LIMITS="${LOADTEST_LIMITS:-true}"
RESOURCE_STATS="${RESOURCE_STATS:-}"
LIMITS_FILE="${SCRIPT_DIR}/compose.limits.yml"

# The stack is started from COMPOSE_DIR, so resolve a relative env file against
# the caller's directory first.
if [[ "${K6_ENV_FILE}" != /* ]]; then
    K6_ENV_FILE="${PWD}/${K6_ENV_FILE}"
fi

ALL_SCENARIOS=(api-auth pre-auth-issuance oid4vp-presentation status-list mixed)

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
            sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'
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
    if [[ "${LOADTEST_LIMITS}" == "true" ]]; then
        echo "Applying resource limits from ${LIMITS_FILE}"
    fi
    (
        cd "${COMPOSE_DIR}"
        docker compose "${COMPOSE_ARGS[@]}" up -d
    )

    wait_for_backend
}

# ---------------------------------------------------------------------------
# Compose arguments: the repository stack, plus resource limits so that
# results are comparable between runs (see compose.limits.yml).
# ---------------------------------------------------------------------------
COMPOSE_ARGS=(--env-file "${K6_ENV_FILE}" --profile "${COMPOSE_PROFILE}" -f "${COMPOSE_DIR}/docker-compose.yml")
if [[ "${LOADTEST_LIMITS}" == "true" ]]; then
    COMPOSE_ARGS+=(-f "${LIMITS_FILE}")
fi

# Whether a reused, already healthy stack is the repository's compose stack.
compose_stack_running() {
    command -v docker &>/dev/null || return 1
    (cd "${COMPOSE_DIR}" && docker compose "${COMPOSE_ARGS[@]}" ps -q eudiplo 2>/dev/null) | grep -q .
}

# ---------------------------------------------------------------------------
# Resource sampling: `docker stats` of the stack's containers while a
# scenario runs, written as JSON lines and summarised as peak CPU / memory.
# ---------------------------------------------------------------------------
STATS_PID=""

start_resource_stats() {
    local out="$1"
    [[ "${RESOURCE_STATS}" == "true" ]] || return 0
    (
        while true; do
            docker stats --no-stream --format '{{json .}}' \
                $(cd "${COMPOSE_DIR}" && docker compose "${COMPOSE_ARGS[@]}" ps -q 2>/dev/null) \
                >> "${out}" 2>/dev/null || true
            sleep 5
        done
    ) &
    STATS_PID=$!
}

stop_resource_stats() {
    if [[ -n "${STATS_PID}" ]]; then
        kill "${STATS_PID}" 2>/dev/null || true
        wait "${STATS_PID}" 2>/dev/null || true
        STATS_PID=""
    fi
}

# Markdown table of peak CPU and memory per container from a stats file.
summarise_resource_stats() {
    local stats_file="$1"
    [[ -s "${stats_file}" ]] || return 0
    command -v node &>/dev/null || return 0
    node "${SCRIPT_DIR}/lib/resource-stats.mjs" "${stats_file}"
}

# Count backend ERROR/WARN log lines since a timestamp (pino-pretty output).
backend_log_counts() {
    local since="$1"
    [[ "${RESOURCE_STATS}" == "true" ]] || return 0
    local logs
    logs="$(cd "${COMPOSE_DIR}" && docker compose "${COMPOSE_ARGS[@]}" logs --no-color --since "${since}" eudiplo 2>/dev/null \
        | sed -E 's/\x1b\[[0-9;]*m//g')" || return 0
    local errors warns
    errors="$(grep -c -E '\b(ERROR|FATAL)\b' <<<"${logs}" || true)"
    warns="$(grep -c -E '\bWARN\b' <<<"${logs}" || true)"
    echo "Backend log lines during the run: ${errors} ERROR/FATAL, ${warns} WARN"
}

start_stack_if_requested
ensure_backend_reachable_when_not_starting_stack

if [[ -z "${RESOURCE_STATS}" ]]; then
    if [[ "${EXTERNAL_TARGET}" != "true" ]] && compose_stack_running; then
        RESOURCE_STATS=true
    else
        RESOURCE_STATS=false
    fi
fi

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
    local prefix="${SUMMARY_DIR}/${TIMESTAMP}-${K6_PROFILE}-${scenario}"
    local summary_file="${prefix}.json"
    local log_file="${prefix}.log"
    local md_file="${prefix}.md"
    local txt_file="${prefix}.txt"
    local stats_file="${prefix}-docker-stats.jsonl"

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

    # Export variables for k6 scripts (__ENV). The summary files are written
    # by handleSummary() in lib/summary.ts, which leaves out setup data (the
    # generated holder key) that --summary-export used to include.
    local env_args=(
        -e "BASE_URL=${BASE_URL}"
        -e "TENANT_ID=${TENANT_ID}"
        -e "CLIENT_ID=${CLIENT_ID}"
        -e "CLIENT_SECRET=${CLIENT_SECRET}"
        -e "K6_PROFILE=${K6_PROFILE}"
        -e "SCENARIO_NAME=${scenario}"
        -e "SUMMARY_FILE=${summary_file}"
        -e "SUMMARY_MD=${md_file}"
        -e "SUMMARY_TXT=${txt_file}"
    )

    local started_at
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    start_resource_stats "${stats_file}"

    local k6_exit=0
    k6 run \
        "${env_args[@]}" \
        ${out_args[@]+"${out_args[@]}"} \
        "${script}" > "${log_file}" 2>&1 || k6_exit=$?

    stop_resource_stats

    # The end-of-run table written by handleSummary; fall back to the log
    # tail when k6 failed before it could write one.
    if [[ -s "${txt_file}" ]]; then
        cat "${txt_file}"
    else
        tail -20 "${log_file}"
    fi

    local resources log_counts
    resources="$(summarise_resource_stats "${stats_file}")"
    log_counts="$(backend_log_counts "${started_at}")"
    [[ -n "${log_counts}" ]] && echo "  ${log_counts}"

    if [[ -f "${md_file}" ]]; then
        {
            if [[ -n "${resources}" ]]; then
                echo "**Resources (peak during the run)**"
                echo ""
                echo "${resources}"
                echo ""
            fi
            if [[ -n "${log_counts}" ]]; then
                echo "${log_counts}"
                echo ""
            fi
        } >> "${md_file}"
        if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
            cat "${md_file}" >> "${GITHUB_STEP_SUMMARY}"
        fi
    fi

    if [[ "${k6_exit}" -eq 0 ]]; then
        echo "PASS: ${scenario}"
        return 0
    else
        echo "FAIL: ${scenario} (k6 exit ${k6_exit}: thresholds breached or error)"
        echo "  Full output: ${log_file}"
        return 1
    fi
}

trap stop_resource_stats EXIT

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
# Baseline comparison: p95 per stage against baseline.json. Reports by
# default; BASELINE_ENFORCE=true turns a regression into a failure. The
# `once` profile has a single sample per stage and is not compared.
# ---------------------------------------------------------------------------
BASELINE_FAILED=false
if [[ "${K6_PROFILE}" != "once" ]] && ! command -v node &>/dev/null; then
    echo ""
    echo "WARNING: node not found; baseline comparison skipped."
    if [[ "${BASELINE_ENFORCE:-false}" == "true" ]]; then
        echo "  BASELINE_ENFORCE=true needs node, failing the run."
        BASELINE_FAILED=true
    fi
elif [[ "${K6_PROFILE}" != "once" ]]; then
    summaries=()
    for scenario in "${RUN_SCENARIOS[@]}"; do
        f="${SUMMARY_DIR}/${TIMESTAMP}-${K6_PROFILE}-${scenario}.json"
        [[ -s "${f}" ]] && summaries+=("${f}")
    done
    if [[ ${#summaries[@]} -gt 0 ]]; then
        compare_args=(--markdown "${SUMMARY_DIR}/${TIMESTAMP}-${K6_PROFILE}-baseline.md")
        echo ""
        compare_exit=0
        node "${SCRIPT_DIR}/compare-baseline.mjs" "${compare_args[@]}" "${summaries[@]}" || compare_exit=$?
        case "${compare_exit}" in
            0) ;;
            1) BASELINE_FAILED=true ;;
            # A broken summary or baseline file is reported but does not fail
            # the load test: the thresholds already decided pass or fail.
            *) echo "WARNING: baseline comparison failed (exit ${compare_exit}); see the output above." ;;
        esac
        if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "${SUMMARY_DIR}/${TIMESTAMP}-${K6_PROFILE}-baseline.md" ]]; then
            cat "${SUMMARY_DIR}/${TIMESTAMP}-${K6_PROFILE}-baseline.md" >> "${GITHUB_STEP_SUMMARY}"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Load Test Summary"
echo "============================================================"
echo "  Ran      : ${#RUN_SCENARIOS[@]} scenario(s)"
echo "  Results  : ${SUMMARY_DIR}/"

if [[ ${#FAILED_SCENARIOS[@]} -eq 0 && "${BASELINE_FAILED}" == "false" ]]; then
    echo "  Status   : ALL PASSED"
    exit 0
else
    [[ ${#FAILED_SCENARIOS[@]} -gt 0 ]] && echo "  FAILED   : ${FAILED_SCENARIOS[*]}"
    [[ "${BASELINE_FAILED}" == "true" ]] && echo "  BASELINE : p95 regression beyond BASELINE_TOLERANCE"
    exit 1
fi
