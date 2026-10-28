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
the rest of the tenant is still imported. This also holds for the tenant
settings in `info.json` (resource `Tenant/tenant`), such as the session and
status list settings; the log names it as `Tenant 'tenant'`. The default access
key chain is a resource of its own, `KeyChainDefaults/defaults` in
`key-chain-defaults.json`, so it is detached and reattached apart from them.

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

The web client lists ownership and offers **Detach** and **Reset to file**, and
for clients from the config folder **Apply from file**, under
**Settings > Config Portability** (shown to a tenant's clients and users with
`tenant:admin` or `tenants:manage`). On the screens of a `file-managed` resource
it shows a lock notice and disables editing and deleting, also for clients that
only have the role managing that resource, such as `issuance:manage` for
credential configs.

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

### Clients with generated secrets

A client file with `"secret": "!generate"` gets a random secret when it is first
imported from this folder or its file changes, but a startup import cannot return it. The backend
writes a warning to its application log (not to the audit log) that names the
client, never the secret:

```text
[acme] Client 'shop-backend' got a generated secret ("secret": "!generate"), which a startup import does not show. ...
```

To get a secret you can use, apply the client from the file again: choose
**Apply from file** in its row under **Settings > Config Portability**, or
reattach it through the API as above, with `Client/shop-backend` in the path.
The client stays `file-managed`, its old secret stops working, and the new one
is shown once in the result. Later startups keep the secret while the file does
not change. To skip this step, give the secret in the file as an environment
variable, for example `"secret": "${SHOP_BACKEND_SECRET}"`.

## Validate in CI

The CLI validates tenant folders against the same schemas as the backend,
without a running instance:

```bash
eudiplo config validate tenants ./config --format json   # every tenant folder
eudiplo config tenant validate acme --config-directory ./config
eudiplo config upgrade ./config --check                  # exit 1 if a file needs an upgrade
```

The commands exit non-zero on any invalid document, which is enough for a CI
gate. The backend runs a few checks on top that the schemas cannot express,
such as the rule that registrar URLs have no query, fragment or credentials,
so an import can still fail on a folder that passed validation. A workflow
that validates every tenant folder and checks for pending upgrades:

```yaml title=".github/workflows/config.yml"
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @eudiplo/cli@10 config validate tenants ./config
      - run: npx @eudiplo/cli@10 config upgrade ./config --check
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
secrets with `${…}` placeholders and private keys with
`keySource: { "type": "required" }`, and lists both as requirements in
`manifest.json`; supply the values on the target instance or let the import
generate them (see
[secret and key policy](../reference/config-bundle-format.md#secret-and-key-policy)).

## Download one resource

**Download configuration** on the page of a credential, issuance or
presentation configuration, a webhook endpoint, an attribute provider, a trust
list or a key chain saves the resource as a document named `<id>.json`, ready
for the config folder. The API is
`GET /api/config-bundles/resources/<kind>/<id>/document`
([single resources](../reference/config-bundle-format.md#single-resources)).
Secrets are `${…}` placeholders, as in a bundle export; the Web Client names
the environment variables to set before the import. **Choose bundle or
document** under **Settings > Config Portability** also takes the file and
plans it like a bundle with that one resource. A key chain document
contains the private keys of a `db` key chain and needs `tenant:admin` or
`tenants:manage`.

## Upgrade old files

After a backend upgrade, files and bundles in an older format keep working on
import, but upgrade them in your repository to stay on the current schemas:

```bash
eudiplo config upgrade acme.zip --dry-run
eudiplo config upgrade acme.zip --output acme-upgraded.zip
eudiplo config upgrade ./config --output ./config-upgraded --diff
```

The command writes to a separate output, never invents missing security-relevant
values, and leaves the output untouched when validation fails. A bundle exported
by a newer release cannot be imported into a release that does not know its
format versions, for example a 10.0 bundle into 9.x
([format versions](../reference/config-bundle-format.md#resource-types-and-versions)).

## Plan and import

Always review the server-side plan, then import exactly that plan:

```bash
eudiplo config plan acme-upgraded.zip --instance staging --mode upsert --diff --output plan.json
eudiplo config import acme-upgraded.zip --instance staging --mode upsert --plan plan.json
```

The plan lists every resource as `create`, `update`, `unchanged`, `skip`,
`delete` or `blocked`, with its field changes (secrets redacted). A plan with a `blocked` item
cannot be applied: fix the reported issue (missing secret, stale generation,
unknown reference, including an OpenID Federation trust anchor that is not
registered, client ID used by another tenant, a deleted trust list or trust
anchor that a configuration still uses) and plan again. A plan
that grants roles beyond the caller's own, or changes a client with more
roles, answers `403` ([granting roles](../reference/roles.md#granting-roles)). The import sends the plan's fingerprint; if
the bundle, the mode or the target configuration changed in between, it fails
with `CONFIG_PLAN_STALE` before writing anything.

The web client does the same under **Settings > Config Portability**:
**Plan and validate** lists each changed field with its current value and its
value after the import, marking secrets as `secret`, values whose type changes
as `changed`, and values the import deletes as `removed`, and **Apply bundle**
imports that plan. It asks for confirmation before applying a plan that removes
stored values, and before every `replace` import.

`replace` deletes resources that the same bundle source created earlier and the
bundle no longer contains. The plan blocks deleting a trust list that a
configuration surviving the import still references, including a configuration
created through the API or Web Client (`TRUST_LIST_IN_USE`, see
[Delete a trust list](../trust/trust-lists.md#delete-a-trust-list)),
deleting a federation trust anchor whose entity ID such a configuration still
names (`FEDERATION_TRUST_ANCHOR_IN_USE`, see
[Delete a trust anchor](../trust/federation.md#delete-a-trust-anchor)),
or deleting a key chain that such a configuration names (`KEY_CHAIN_IN_USE`, see
[Delete a key chain](../trust/keys-and-certificates.md#delete-a-key-chain)). It needs
its own plan and an explicit confirmation:

```bash
eudiplo config plan acme.zip --instance staging --mode replace --output replace-plan.json
eudiplo config import acme.zip --instance staging --mode replace \
  --plan replace-plan.json --confirm-replace
```

Client secrets generated during the import (`"secret": "!generate"`) are
returned once in the import result; store them immediately. The client keeps its
secret on later imports of the same document from the same source; change the
document or raise `metadata.generation` to get a new one
([details](../reference/config-bundle-format.md#import-modes-and-plan-actions)).
A startup import cannot return the secret; see
[clients with generated secrets](#clients-with-generated-secrets).

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
