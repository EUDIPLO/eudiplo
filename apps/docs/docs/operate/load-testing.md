---
title: Load Testing
---

# Load Testing

Measure how a deployment handles token requests, pre-authorized issuance,
complete OID4VP presentations and status-list reads, alone or as a mixed
workload, with the k6 suite in `scripts/load-test`. The runner can start the repository's Compose stack or
target a deployment that is already running.

## Before you start

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 2.0 or newer
- Docker, only if the runner should start the local stack
- Node.js 22.18 or newer for the resource table, the baseline comparison and the
  unit tests of the suite
- For a running deployment: an OAuth client and a tenant with issuance and
  presentation configurations (the local stack imports the demo tenant)

## Run against the local stack

```bash
./scripts/load-test/run-all.sh --once
```

The runner starts `deployment/docker-compose` with the `standard` profile
(`COMPOSE_PROFILE`) and the env file `deployment/docker-compose/k6.env`
(`K6_ENV_FILE`; a relative path is resolved against the current directory),
waits for `/health` and runs every scenario once. `k6.env` mounts
`assets/config` and imports the demo tenant on startup, with the client
`test-client` that the scenarios use by default. Another env file must set
`EUDIPLO_ENV_FILE` to its own path, as `k6.env` does, so that the backend reads
it too. If a backend already answers at `HEALTH_URL`, the runner uses it instead
of starting the stack. When the runner starts the stack it applies
`scripts/load-test/compose.limits.yml`, which limits the backend to 2 CPUs and
2 GB and Postgres to 1 CPU and 1 GB, so that results are comparable between runs
and k6 is not competing with the backend for the same cores. Change the limits
with `LOADTEST_BACKEND_CPUS`, `LOADTEST_BACKEND_MEMORY`, `LOADTEST_DB_CPUS` and
`LOADTEST_DB_MEMORY`, or start without them with `LOADTEST_LIMITS=false`.

## Run against a deployment

`--external` does not start Docker and requires an explicit target. Start with
`--once` before applying sustained load:

```bash
BASE_URL=https://eudiplo.example.com \
TENANT_ID=load-test \
CLIENT_ID=load-test-client \
CLIENT_SECRET=<secret> \
./scripts/load-test/run-all.sh --external --once
```

Use a dedicated test environment: the issuance and presentation scenarios create
persistent sessions and revoke credentials, and the `load`, `stress` and `spike`
profiles generate substantial traffic. Use [least-privilege client roles](tenants-and-access.md#api-clients-with-least-privilege)
for the test client: `issuance:offer` and `presentation:request` for the flows,
and `credentials:status` for revocations (or `REVOKE_RATIO=0`). The presentation scenario issues its test
credentials in setup, so the tenant needs an issuance configuration whose
credentials the presentation configuration accepts.

The wallet steps follow the URLs in offers and request objects, which the
backend builds from `PUBLIC_URL`, so k6 must reach the backend at that address.

The runner waits for `BASE_URL/health`. Set `HEALTH_URL` if health checks are
exposed elsewhere, or `SKIP_HEALTH_CHECK=true` if a gateway hides them; the
first request then serves as the connectivity check. For private certificate
authorities, `K6_INSECURE_SKIP_TLS_VERIFY=true` disables certificate checks; use
it only in a controlled test environment.

## Profiles

Each scenario states the rate it should sustain under `load` (for example 10
issuances per second) and the latency it must meet at that rate. The profile in
`K6_PROFILE` (default `smoke`, `--once` forces `once`) turns that into the
actual workload:

| Profile  | Workload                                                  | Thresholds                                  |
| -------- | --------------------------------------------------------- | ------------------------------------------- |
| `once`   | One iteration with one virtual user                       | As written, at most 1 % failed requests     |
| `smoke`  | 10 % of the scenario rate for 1 minute                    | As written, at most 1 % failed requests, no dropped iterations |
| `load`   | Ramp to the scenario rate in 1 minute, hold 5 minutes     | As written, at most 1 % failed requests, no dropped iterations |
| `stress` | Ramp to 2× and 4× the scenario rate                       | Latency ×3, up to 5 % failed requests       |
| `spike`  | Jump to 10× the scenario rate for 1 minute, then recover  | Latency ×5, up to 10 % failed requests      |

All profiles except `once` use k6's arrival-rate executors: k6 starts iterations at the
stated rate whether or not earlier ones have finished, as independent wallets
would. When the backend slows down, the load does not back off; latency grows
and k6 reports `dropped_iterations` once it runs out of virtual users. In
`smoke` and `load` a dropped iteration fails the run; in `stress` and `spike` it
marks the point where the deployment saturates.

Every scenario also requires more than 99 % of its checks to pass.

Under `load` and `stress` the flows pause 1–5 seconds between the operator
creating an offer and the wallet using it, and again before the wallet answers
a presentation request, like a user scanning a QR code and confirming the
disclosure. This keeps sessions open concurrently as in production. Set
`THINK_TIME_MIN` and `THINK_TIME_MAX` (seconds) to change it; `once` and `smoke`
default to no pause and `spike` to 0–1 seconds.

## Scenarios

Without scenario arguments the runner executes all five. Name scenarios to run a
subset:

```bash
K6_PROFILE=load ./scripts/load-test/run-all.sh --external api-auth pre-auth-issuance
```

| Scenario              | Rate under `load`  | Exercises                                                          |
| --------------------- | ------------------ | ------------------------------------------------------------------ |
| `api-auth`            | 30/s               | `POST /api/oauth2/token`                                           |
| `pre-auth-issuance`   | 10/s               | Offer, token, nonce and credential request of the pre-authorized flow with a generated holder key; revokes a share of the issued credentials, which re-signs the status list |
| `oid4vp-presentation` | 10/s               | Presentation request, request object, and the wallet response: an SD-JWT VC presentation with key binding, encrypted for the verifier, so signature, trust-list, status-list and DCQL checks run under load |
| `status-list`         | 200/s              | Status list discovery and downloads; when the tenant has no status list yet, setup issues one credential |
| `mixed`               | 10 + 10 + 100 + 5/s | Issuance, presentation, status-list reads and token requests at the same time |

`mixed` is the scenario for a capacity figure: the flows compete for the same
database, keys and CPUs as in production. Its rates default to 10 issuances,
10 presentations, 100 status checks and 5 token requests per second and are set
with `MIXED_ISSUANCE_RATE`, `MIXED_PRESENTATION_RATE`, `MIXED_STATUS_LIST_RATE`
and `MIXED_AUTH_RATE`.

The flows request the operator token once in setup and reuse it, renewing it
shortly before it expires; only `api-auth` and the token flow of `mixed` request
a token per iteration. Requests made in setup are not part
of the per-stage latencies.

## Variables

| Variable            | Default                  | Meaning                                                     |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| `K6_PROFILE`        | `smoke`                  | `once`, `smoke`, `load`, `stress` or `spike`                |
| `TENANT_ID`         | `demo`                   | Tenant used by the scenarios                                |
| `CLIENT_ID`, `CLIENT_SECRET` | `test-client`, `test-client-secret` | OAuth client of that tenant              |
| `CREDENTIAL_CONFIG_ID` | `pid`                 | Credential configuration issued by the flows                |
| `REQUEST_ID`        | `age-over-18`            | Presentation configuration used by the presentation flow    |
| `REVOKE_RATIO`      | `0.1`                    | Share of issued credentials that are revoked (0 to 1)       |
| `CREDENTIAL_POOL_SIZE` | `5`                   | Credentials issued in setup for the presentation flow       |
| `CREDENTIAL_JWT`, `HOLDER_PRIVATE_JWK` | -     | Present this SD-JWT VC, bound to this key, instead of issuing credentials in setup |
| `DCQL_CREDENTIAL_ID` | first `dc+sd-jwt` query | DCQL credential query the wallet answers                    |
| `CHECK_SESSION_RESULT` | `false`               | Also read each presentation session and expect `completed`  |
| `THINK_TIME_MIN`, `THINK_TIME_MAX` | per profile | Seconds the user pauses between steps                    |
| `SEED_SESSIONS`     | `0`                      | Sessions created in setup before the measured run (see below) |
| `SEED_BATCH_SIZE`   | `50`                     | Parallel requests per seeding batch                         |
| `K6_SETUP_TIMEOUT`  | `15m`                    | Time allowed for setup: credential pool and seeding         |
| `MAX_LISTS`         | `5`                      | Maximum number of status lists fetched per iteration        |
| `SUMMARY_DIR`       | `scripts/load-test/results` | Output directory                                         |
| `CLEAN_RESULTS`     | `true`                   | Delete earlier results before the run                       |
| `START_STACK`       | `true`                   | Start the Compose stack when no backend answers at `HEALTH_URL` |
| `PAUSE_BETWEEN`     | `5`                      | Seconds between scenarios (`--once` sets 0)                 |
| `PROMETHEUS_RW_URL` | -                        | Also push k6 metrics to a Prometheus remote-write endpoint  |
| `BASELINE_TOLERANCE` | `0.2`                   | Allowed p95 increase over the baseline                      |
| `BASELINE_MIN_MS`   | `5`                      | Ignore p95 increases of at most this many milliseconds      |
| `BASELINE_ENFORCE`  | `false`                  | Fail the run when a stage exceeds the tolerance             |
| `RESOURCE_STATS`    | see [Results](#results)  | Sample `docker stats`, capture the backend log and count its errors |

## Existing data

A fresh stack has empty session tables, so slow queries and missing indexes only
show once data accumulates. With `SEED_SESSIONS=20000`, the setup of
`pre-auth-issuance`, `oid4vp-presentation` and `mixed` creates that many
sessions, half issuance offers and half presentation requests, before the
measured run starts. Each of these scenarios seeds on its own, so a run of all
scenarios adds the sessions three times; `api-auth` and `status-list` ignore
`SEED_SESSIONS`. The sessions are never redeemed, like abandoned QR codes:

```bash
K6_PROFILE=load SEED_SESSIONS=20000 ./scripts/load-test/run-all.sh mixed
```

## Results

For each scenario the runner writes to `SUMMARY_DIR`, with the run's timestamp
and profile in the file name:

| File                     | Content                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `….json`                 | Metrics, thresholds and checks; contains no key material   |
| `….md`, `….txt`          | Latency per stage (median, p95, p99, max) with thresholds  |
| `….log`                  | k6 output                                                  |
| `…-docker-stats.jsonl`   | `docker stats` samples of the stack, with `RESOURCE_STATS` (see below) |
| `…-backend.log`          | The backend's log lines during the scenario, with `RESOURCE_STATS` |

Once per run, except with `once`, the runner also writes `…-baseline.md` with the
baseline comparison.

When the target is the repository's Compose stack, whether the runner started
it or found it running, the runner samples `docker stats` during each scenario.
The Markdown report then lists the peak CPU and memory per container and the
number of `ERROR`/`FATAL` and `WARN` lines the backend logged during the run.
`RESOURCE_STATS=true` or `false` overrides this. In GitHub Actions the reports
are added to the job summary, and every failed scenario gets an error
annotation on the checks with the breached thresholds, failed checks, the most
frequent k6 errors (for a rejected presentation, with the verifier's reason) and,
with `RESOURCE_STATS`, the most frequent backend `WARN`, `ERROR` and `FATAL`
messages.

After the scenarios, the runner compares the p95 of every stage with
`scripts/load-test/baseline.json` for the same profile and reports stages that
are more than `BASELINE_TOLERANCE` (20 %) and more than `BASELINE_MIN_MS` (5 ms)
slower. Set `BASELINE_ENFORCE=true` to fail the run on such a regression. `once`
runs are not compared, and a profile or scenario without a recorded baseline is
reported as such and never fails. A stage in the baseline that the run did not
measure is listed as missing. Without Node.js the comparison is skipped with a
warning, and `BASELINE_ENFORCE=true` then fails the run. To record a new baseline from a run, for
example after an intended change or on different hardware:

```bash
node scripts/load-test/compare-baseline.mjs --update scripts/load-test/results/*-smoke-*.json
```

Baselines depend on the hardware and the resource limits; compare runs from the
same environment.

## Continuous integration

The `Load Tests` workflow builds the backend image and runs the suite against
the local stack:

- on pull requests that change `scripts/load-test`, `deployment/docker-compose`
  or the workflow: all scenarios with `smoke`
- every Monday: all scenarios with `smoke`
- every Wednesday: `mixed` with `load` on 20 000 pre-seeded sessions
- manually, with a scenario, profile and number of seeded sessions of your choice

The results are uploaded as the `k6-results-<run id>` artifact, together with
the logs of the stack in `compose.log`. Before the backend is built, the
workflow runs the unit tests of the suite:

```bash
node --import ./scripts/load-test/test/shims/register.mjs --test 'scripts/load-test/test/*.test.mjs'
```

To see the backend side of a run, start the [monitoring stack](monitoring.md)
and set `PROMETHEUS_RW_URL=http://localhost:9090/api/v1/write`.
