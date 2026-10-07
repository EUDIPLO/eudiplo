---
title: Load Testing
---

# Load Testing

Measure how a deployment handles token requests, pre-authorized issuance,
OID4VP presentation requests and status-list reads with the k6 suite in
`scripts/load-test`. The runner can start the repository's Compose stack or
target a deployment that is already running.

## Before you start

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 2.0 or newer
- Docker, only if the runner should start the local stack
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
of starting the stack. Each scenario writes a JSON summary and a log with k6's
end-of-run metrics to `scripts/load-test/results/`.

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
persistent sessions, and the `load`, `stress` and `spike` profiles generate
substantial traffic. Use [least-privilege client roles](tenants-and-access.md#api-clients-with-least-privilege)
for the test client.

The runner waits for `BASE_URL/health`. Set `HEALTH_URL` if health checks are
exposed elsewhere, or `SKIP_HEALTH_CHECK=true` if a gateway hides them; the
first request then serves as the connectivity check. For private certificate
authorities, `K6_INSECURE_SKIP_TLS_VERIFY=true` disables certificate checks; use
it only in a controlled test environment.

## Profiles and scenarios

| Variable            | Default                  | Meaning                                                     |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| `K6_PROFILE`        | `smoke`                  | `once`, `smoke`, `load`, `stress` or `spike` (`--once` forces `once`) |
| `TENANT_ID`         | `demo`                   | Tenant used by the scenarios                                |
| `CLIENT_ID`, `CLIENT_SECRET` | `test-client`, `test-client-secret` | OAuth client of that tenant              |
| `CREDENTIAL_CONFIG_ID` | `pid`                 | Credential configuration offered by `pre-auth-issuance`     |
| `REQUEST_ID`        | `age-over-18`            | Presentation configuration used by `oid4vp-presentation`    |
| `MAX_LISTS`         | `5`                      | Maximum number of status lists fetched per iteration        |
| `SUMMARY_DIR`       | `scripts/load-test/results` | Output directory                                         |
| `CLEAN_RESULTS`     | `true`                   | Delete earlier results before the run                       |
| `PROMETHEUS_RW_URL` | -                        | Also push k6 metrics to a Prometheus remote-write endpoint  |

Without scenario arguments the runner executes all four. Name scenarios to run a
subset:

```bash
K6_PROFILE=load ./scripts/load-test/run-all.sh --external api-auth pre-auth-issuance
```

| Scenario              | Exercises                                                          |
| --------------------- | ------------------------------------------------------------------ |
| `api-auth`            | `POST /api/oauth2/token`                                           |
| `pre-auth-issuance`   | Offer, token, nonce and credential request of the pre-authorized flow, with a generated holder key |
| `oid4vp-presentation` | Presentation request creation and request object retrieval (no wallet response) |
| `status-list`         | Status list downloads; needs at least one issued status-managed credential |

To see the backend side of a run, start the [monitoring stack](monitoring.md)
and set `PROMETHEUS_RW_URL=http://localhost:9090/api/v1/write`.
