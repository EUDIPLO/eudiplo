---
title: Load Testing
---

# Load Testing

The k6 suite exercises authentication, pre-authorized credential issuance, OID4VP presentation requests, and status-list reads. It can start the repository's Docker Compose stack or target an EUDIPLO deployment that is already running.

## Prerequisites

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 2.0 or newer
- Docker, only when the runner should start the local stack
- An OAuth client and tenant that exist in the target deployment

Run a single iteration of every scenario against the local Compose stack:

```bash
./scripts/load-test/run-all.sh --once
```

Results are written to `scripts/load-test/results/`. Each scenario produces a JSON summary and a log containing k6's end-of-run metrics.

## Test a Self-Hosted Deployment

`--external` prevents the runner from starting Docker and requires an explicit target URL. Start with the `once` profile before applying sustained load:

```bash
BASE_URL=https://eudiplo.example.com \
TENANT_ID=production-like-test-tenant \
CLIENT_ID=load-test-client \
CLIENT_SECRET=replace-me \
./scripts/load-test/run-all.sh --external --once
```

The target must be a dedicated test environment. The issuance and presentation scenarios create persistent data, and the load, stress, and spike profiles can generate substantial traffic.

By default the runner waits for `BASE_URL/health`. Deployments that expose health checks through a different route can override it:

```bash
HEALTH_URL=https://status.example.com/eudiplo/ready \
BASE_URL=https://eudiplo.example.com \
./scripts/load-test/run-all.sh --external --once api-auth
```

If a gateway deliberately hides all health endpoints, set `SKIP_HEALTH_CHECK=true`. In that mode, the first scenario request is the connectivity check.

For private certificate authorities, use k6's standard `K6_INSECURE_SKIP_TLS_VERIFY=true` only in a controlled test environment.

## Profiles and Scenarios

Set `K6_PROFILE` to `once`, `smoke`, `load`, `stress`, or `spike`. With no scenario arguments, the runner executes all four scenarios. To run a subset, list their names after the flags:

```bash
K6_PROFILE=load ./scripts/load-test/run-all.sh \
  --external api-auth pre-auth-issuance
```

Available scenarios:

- `api-auth`
- `pre-auth-issuance`
- `oid4vp-presentation`
- `status-list`

The status-list scenario expects at least one status-managed credential to have been issued for the tenant. `CREDENTIAL_CONFIG_ID` defaults to `pid`, and `MAX_LISTS` limits how many status lists each iteration fetches.

To retain previous results, set `CLEAN_RESULTS=false`. Set `SUMMARY_DIR` to write result files elsewhere. `PROMETHEUS_RW_URL` enables k6's experimental Prometheus remote-write output in addition to the local summaries.
