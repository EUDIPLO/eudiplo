---
title: Configuration as Code
---

# Configuration as Code

Keep tenant configuration in files, validate it in CI, and move it between
instances with reviewed plans. The file layout, envelope, versions and plan
semantics are specified in the [config bundle format](../reference/config-bundle-format.md).

## Configuration model

A tenant's configuration (credential, issuance and presentation configs, key
chains, clients, trust lists, KMS and registrar settings, …) consists of JSON
documents with a `$schema`, optional `metadata` and the `spec`. The backend
stores them in the database. They get there in three ways:

| Way                     | Use it for                                     | Ownership after the write   |
| ----------------------- | ---------------------------------------------- | --------------------------- |
| Startup import          | Tenant folders in `CONFIG_FOLDER`, GitOps      | `file-managed`              |
| Bundle import (API/CLI) | Promoting a tenant between instances           | `file-managed`              |
| Management API, web client | Ad-hoc changes                              | `unmanaged`                 |

A `file-managed` resource rejects API and web client edits with `409 Conflict`,
so a later import cannot silently overwrite manual changes. Detach it to edit it
by hand:

```bash
curl -X POST "$EUDIPLO_URL/api/config-bundles/resources/PresentationConfig/age-check/detach" \
  -H "Authorization: Bearer $EUDIPLO_TOKEN"
```

A detached resource has the ownership `detached` and stays detached while you
edit it. The startup import skips it with the warning `RESOURCE_DETACHED`, and
the rest of the tenant is still imported.

To discard your edits and return to the file version, reattach the resource. Plan
first, review the changes, then apply with the plan's fingerprint:

```bash
curl -X POST "$EUDIPLO_URL/api/config-bundles/resources/PresentationConfig/age-check/reattach/plan" \
  -H "Authorization: Bearer $EUDIPLO_TOKEN"
curl -X POST "$EUDIPLO_URL/api/config-bundles/resources/PresentationConfig/age-check/reattach?planFingerprint=$FINGERPRINT" \
  -H "Authorization: Bearer $EUDIPLO_TOKEN"
```

Reattaching reads the resource from the tenant folder in `CONFIG_FOLDER`,
applies it, and makes the resource `file-managed` again. Its stored generation
becomes the file's generation, so later startups apply the folder again.

The web client lists ownership and offers **Detach** and **Reset to file** under
**Settings > Config Portability** (shown with `tenant:admin` or
`tenants:manage`).

## Provision tenants from a folder

Mount a config root with one folder per tenant and enable the startup import:

```env
CONFIG_FOLDER=/app/config
CONFIG_IMPORT_MODE=create
```

| `CONFIG_IMPORT_MODE` | On every start                                                                      |
| -------------------- | ----------------------------------------------------------------------------------- |
| `disabled` (default) | Nothing is imported                                                                 |
| `create`             | Creates missing resources, leaves existing ones untouched                           |
| `upsert`             | Creates missing and updates existing resources                                      |
| `replace`            | Like `upsert`, and deletes resources this folder created earlier but no longer contains |

If a resource in the folder has a lower `metadata.generation` than the stored
one, it was changed through the API or web client. The startup import skips it
with the warning `STALE_GENERATION` and imports the rest of the tenant. Reattach
the resource to apply the file version, or raise `metadata.generation` in the
file to at least the stored generation shown under **Settings > Config
Portability**.

A folder of a tenant that does not exist yet is imported only if it contains
`info.json`. String values can reference environment variables as `${VAR}` or
`${VAR:default}`; with the default `CONFIG_VARIABLE_STRICT=skip`, an unresolved
placeholder fails the import of that tenant while other tenants continue.
Restart the backend to apply changed files. The folder layout is listed in the
[format reference](../reference/config-bundle-format.md#tenant-folder-layout).

## Validate in CI

The CLI validates tenant folders against the same schemas as the backend,
without a running instance:

```bash
eudiplo config validate tenants ./config --format json   # every tenant folder
eudiplo config tenant validate acme --config-directory ./config
eudiplo config upgrade ./config --check                  # exit 1 if a file needs an upgrade
```

The commands exit non-zero on any invalid document, which is enough for a CI
gate:

```yaml title=".github/workflows/config.yml"
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @eudiplo/cli@9 config validate tenants ./config
      - run: npx @eudiplo/cli@9 config upgrade ./config --check
```

Use the CLI major version that matches your backend. For completion and inline
validation in VS Code, run `eudiplo config editor setup` in the repository; it
copies the schemas of the installed CLI to `.vscode/eudiplo-schemas/` and adds
the file associations to `.vscode/settings.json`.

## Export a tenant

Bundle commands act on one tenant and need a token bound to that tenant with the
`tenant:admin` role (or `tenants:manage`). The tenant-less root client cannot
export. Create an admin client for the tenant once, for example with
`POST /api/tenant` and `"roles": ["tenant:admin"]` (see
[Tenants and access](tenants-and-access.md#create-a-tenant)), then:

```bash
export EUDIPLO_TOKEN="$(curl -s -X POST https://eudiplo.example.com/api/oauth2/token \
  -d grant_type=client_credentials -d client_id=acme-admin -d client_secret="$SECRET" \
  | jq -r .access_token)"

eudiplo config export --instance production --output acme.zip
```

The export never contains secrets or database-held private keys. It replaces
them with `${…}` placeholders and lists them as requirements in `manifest.json`;
supply the values on the target instance or let the import generate them (see
[secret and key policy](../reference/config-bundle-format.md#secret-and-key-policy)).

## Upgrade old files

After a backend upgrade, files and bundles in an older format keep working on
import, but upgrade them in your repository to stay on the current schemas:

```bash
eudiplo config upgrade acme.zip --dry-run
eudiplo config upgrade acme.zip --output acme-upgraded.zip
eudiplo config upgrade ./config --output ./config-upgraded --diff
```

The command writes to a separate output, never invents missing security-relevant
values, and leaves the output untouched when validation fails. A 9.0 bundle
cannot be imported into 8.x: since 9.0, IssuanceConfig files are format
version 2 and PresentationConfig files version 3.

## Plan and import

Always review the server-side plan, then import exactly that plan:

```bash
eudiplo config plan acme-upgraded.zip --instance staging --mode upsert --diff --output plan.json
eudiplo config import acme-upgraded.zip --instance staging --mode upsert --plan plan.json
```

The plan lists every resource as `create`, `update`, `unchanged`, `skip`,
`delete` or `blocked`, with redacted field changes. A plan with a `blocked` item
cannot be applied: fix the reported issue (missing secret, stale generation,
unknown reference) and plan again. The import sends the plan's fingerprint; if
the bundle, the mode or the target configuration changed in between, it fails
with `CONFIG_PLAN_STALE` before writing anything.

`replace` deletes resources that the same bundle source created earlier and the
bundle no longer contains. It needs its own plan and an explicit confirmation:

```bash
eudiplo config plan acme.zip --instance staging --mode replace --output replace-plan.json
eudiplo config import acme.zip --instance staging --mode replace \
  --plan replace-plan.json --confirm-replace
```

Client secrets generated during the import (`"secret": "!generate"`) are
returned once in the import result; store them immediately.

## Plans, locks and recovery

One configuration writer per tenant runs at a time, across all replicas. Imports,
config API edits and asset uploads take this lock; issuance, presentations and
status updates continue.

An import is not one transaction. If a step fails, the API returns
`CONFIG_APPLY_FAILED` with an ordered report: completed steps stay applied, the
failed step may be partial, later steps (including deletions) do not run.
Inspect the affected resources, fix the cause, and plan again. Progress is also
stored in the database:

```bash
eudiplo config operations --instance staging                 # latest 50 operations
eudiplo config operations <operation-id> --instance staging  # one report
```

If the backend crashed during an import, the operation stays `running` and keeps
the tenant lock. Make sure the original process is stopped on every replica,
then release the lock:

```bash
eudiplo config recover <operation-id> --instance staging --confirm-worker-stopped
```

Recovery marks the operation `interrupted`; it does not undo or replay steps.
Check the resource the report shows as `running`, then create a new plan. Rotate
any client secret whose import response was lost.
