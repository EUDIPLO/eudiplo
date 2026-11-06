---
title: "Cookbook: Manage an Instance with the CLI"
sidebar_label: Manage with the CLI
---

You manage a running EUDIPLO instance from the command line: you keep a tenant's configuration as files next to the deployment, check them before every start, apply them with a restart and gate changes in CI. The result is a tenant whose configuration lives in Git and cannot be changed behind your back in the Web Client.

## What you will build

A tenant `membership-files`, defined by five JSON files in the `config/` folder of your Compose project: the tenant settings, an admin client, a signing key chain, the issuer settings and the `membership` credential type from the [Issue and verify](first-credential.md) recipe. The backend imports the folder on every start, so a file change and a restart update the tenant. Secrets and private keys stay out of the files.

## Before you start

- **Starts from:** [chapter 1, Install and connect](foundation.md). The CLI instance `cookbook` runs, and you work in its project directory `eudiplo-cookbook`. Keep the tunnel running: the CLI reaches the instance at its public URL. Chapters 2 and 3 are not needed; this recipe creates its own tenant.
- **Without chapter 1** (no wallet or tunnel needed), [install the CLI](../operate/cli.md#install), start Docker or Podman, and create the instance on `http://localhost:3000`:

    ```bash
    eudiplo init eudiplo-cookbook --instance cookbook --preset minimal \
      --no-demo-tenant --client --yes --start
    cd eudiplo-cookbook
    ```

- `jq`, `openssl` and Git. A GitHub repository is optional for step 6.

## Step 1: Look at the instance

```bash
eudiplo instance show cookbook
eudiplo status --instance cookbook
eudiplo ps --instance cookbook
```

`instance show` prints what the CLI knows about the deployment: target `compose`, the API URL, the project directory and the env file `.eudiplo.env`. Instances and their targets are explained in the [CLI guide](../operate/cli.md#instances).

**Checkpoint:** `eudiplo status` prints `PASS` for the health endpoint, and `eudiplo ps` lists `eudiplo` and `eudiplo-client` as running.

## Step 2: Create the tenant folder

```bash
eudiplo config tenant create membership-files --instance cookbook --name "Membership Files"
eudiplo config editor setup
```

The first command creates `config/membership-files/` with `info.json` (the tenant settings) and an empty folder for each resource type. The backend reads `config/` as its `CONFIG_FOLDER` and treats every subfolder with an `info.json` as a tenant. `config editor setup` copies the JSON schemas of the installed CLI to `.vscode/eudiplo-schemas/` and associates them with the files under `config/`, so VS Code completes and checks them while you type.

**Checkpoint:** `eudiplo config tenant list --instance cookbook` lists `membership-files (Membership Files)`.

## Step 3: Describe the tenant in files

Create these four files in `config/membership-files/`.

`clients/membership-files-admin.json`, the client you administer the tenant with:

```json
{
  "$schema": "https://eudiplo.dev/schemas/v2/ClientConfigFile.schema.json",
  "metadata": { "generation": 1 },
  "spec": {
    "clientId": "membership-files-admin",
    "description": "Administers the tenant from the CLI",
    "secret": "${MEMBERSHIP_FILES_ADMIN_SECRET}",
    "roles": ["tenant:admin", "issuance:manage"]
  }
}
```

`tenant:admin` lets the client read the configuration operations and export the tenant. `issuance:manage` opens the issuer screens of the Web Client and lets `doctor` read the KMS provider health. The secret is a placeholder that the backend fills from its environment.

`key-chains/membership-signing.json`, the key that signs the credentials:

```json
{
  "$schema": "https://eudiplo.dev/schemas/v4/KeyChainConfigFile.schema.json",
  "metadata": { "generation": 1 },
  "spec": {
    "id": "membership-signing",
    "description": "Membership credential signing",
    "usageType": "attestation",
    "keySource": { "type": "regenerate", "keyChainType": "internalChain" }
  }
}
```

`regenerate` makes EUDIPLO create the key material on the first import, so the private key never appears in a file and every instance you apply the folder to gets a key of its own. Restarts with the unchanged file keep the key. A change to this file, even to `description`, creates a new key on the next start ([details](../reference/config-bundle-format.md#import-modes-and-plan-actions)).

`issuance/issuance.json`, the issuer settings:

```json
{
  "$schema": "https://eudiplo.dev/schemas/v6/IssuanceConfigFile.schema.json",
  "metadata": { "generation": 1 },
  "spec": {
    "authorizationServers": [{ "id": "issuer-built-in", "type": "built-in" }],
    "batchSize": 1,
    "display": [{ "locale": "en-US", "name": "Membership Files" }]
  }
}
```

`issuance/credentials/membership.json`, the credential type with the VCT and claims of the other recipes:

```json
{
  "$schema": "https://eudiplo.dev/schemas/v3/CredentialConfigFile.schema.json",
  "metadata": { "generation": 1 },
  "spec": {
    "id": "membership",
    "description": "Membership credential",
    "config": {
      "format": "dc+sd-jwt",
      "display": [{ "name": "Membership", "locale": "en-US" }]
    },
    "vct": "urn:example:membership:1",
    "keyBinding": true,
    "keyChainId": "membership-signing",
    "fields": [
      { "path": ["name"], "type": "string", "mandatory": true, "disclosable": true },
      { "path": ["member_id"], "type": "string", "mandatory": true, "disclosable": true }
    ]
  }
}
```

Then generate the client secret, store it in the env file that the backend reads, and validate the folder:

```bash
export MEMBERSHIP_FILES_ADMIN_SECRET="$(openssl rand -hex 32)"
echo "MEMBERSHIP_FILES_ADMIN_SECRET=$MEMBERSHIP_FILES_ADMIN_SECRET" >> .eudiplo.env
eudiplo config tenant validate membership-files --instance cookbook
```

The validator checks every file against its schema and resolves `${…}` placeholders from your shell environment, as the backend does from its own. Keep this shell open: the next steps use the variable.

**Checkpoint:** the validation prints `PASS membership-files`, `Validated 1 tenant(s) and 5 configuration file(s).` and `No errors found.`

## Step 4: Import the folder on every start

`eudiplo init` sets `CONFIG_IMPORT_MODE=create`, which only creates missing resources and never applies a later change to a file. In `.eudiplo.env`, change that line to:

```env
CONFIG_IMPORT_MODE=upsert
```

Then recreate the backend, so it reads the new mode and the new secret:

```bash
eudiplo up --instance cookbook
curl -s http://localhost:3000/.well-known/openid-credential-issuer/issuers/membership-files \
  | jq '.credential_configurations_supported | keys'
```

The import modes are compared in [Configuration as code](../operate/configuration-as-code.md#provision-tenants-from-a-folder). Each import is recorded as a configuration operation. Read the latest one with the new client:

```bash
export EUDIPLO_CLIENT_ID=membership-files-admin
export EUDIPLO_CLIENT_SECRET="$MEMBERSHIP_FILES_ADMIN_SECRET"
export EUDIPLO_TOKEN="$(curl -s -X POST http://localhost:3000/api/oauth2/token \
  -d grant_type=client_credentials -d client_id="$EUDIPLO_CLIENT_ID" \
  --data-urlencode client_secret="$EUDIPLO_CLIENT_SECRET" | jq -r .access_token)"
eudiplo config operations --instance cookbook | jq '.[0] | {mode, status}'
```

`doctor` requests its own token with `EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET`; `config operations`, `export`, `plan` and `import` take a ready token from `EUDIPLO_TOKEN`. When they answer `401`, request a new token.

**Checkpoint:** the metadata lists `["membership"]`, and the latest operation shows `"mode": "upsert"` and `"status": "completed"`.

## Step 5: Change the tenant through its files

Sign in to the Web Client (`eudiplo open --instance cookbook`) with **Client ID** `membership-files-admin` and the secret from `echo "$MEMBERSHIP_FILES_ADMIN_SECRET"`. Open **Credential Issuance → Credential Types → membership**: the page shows **Managed by a configuration bundle**, and editing and deleting are disabled. The API refuses such changes with `409 Conflict`, so a manual edit cannot be overwritten silently by the next import.

Change the file instead. In `issuance/credentials/membership.json`, rename the display from `Membership` to `Membership card`, then:

```bash
eudiplo config tenant validate membership-files --instance cookbook
eudiplo restart --instance cookbook --service eudiplo
curl -s http://localhost:3000/.well-known/openid-credential-issuer/issuers/membership-files \
  | jq '.credential_configurations_supported.membership.credential_metadata.display'
```

`restart` returns before the backend is ready, so repeat the `curl` if it gets no answer. It is enough when only files changed; after a change to `.eudiplo.env`, run `eudiplo up`, because a restart keeps the old environment. For an urgent fix in the Web Client, detach the resource first and reattach it later ([Configuration as code](../operate/configuration-as-code.md#configuration-model)).

**Checkpoint:** after the backend is back up, the display reads `"name": "Membership card"`.

## Step 6: Version the project and check it in CI

Put the project under Git, without its secrets and database:

```bash
printf '%s\n' .eudiplo.env 'config/service.db*' > .gitignore
git init
git add .
git commit -m "EUDIPLO cookbook instance"
```

`.eudiplo.env` holds `MASTER_SECRET`, which encrypts the keys in the database, and every client secret; keep it in a secret manager, never in Git. `config/service.db` is the SQLite database of the `minimal` preset.

To check every change before it reaches an instance, add `.github/workflows/eudiplo-config.yml`:

```yaml title=".github/workflows/eudiplo-config.yml"
name: EUDIPLO configuration
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    env:
      MEMBERSHIP_FILES_ADMIN_SECRET: ci-placeholder
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @eudiplo/cli@10 config validate tenants ./config
```

Use the CLI major version that matches your backend. The dummy value only lets the placeholder resolve; the real secret stays on the instance ([Validate in CI](../operate/configuration-as-code.md#validate-in-ci)). The backend runs a few checks that the schemas cannot express, so an import can still fail on a folder that passed (see [Troubleshooting](#troubleshooting)).

**Checkpoint:** the job's command passes locally without the real secret, and on GitHub the workflow passes:

```bash
MEMBERSHIP_FILES_ADMIN_SECRET=ci-placeholder eudiplo config validate tenants ./config
```

## Step 7: Check the whole deployment

```bash
eudiplo doctor --instance cookbook
```

`doctor` runs the checks listed in the [CLI guide](../operate/cli.md#check-an-instance-with-doctor). With the tenant client from step 4 it also reads the KMS provider health, which it skips for the tenant-less root client.

**Checkpoint:** no check reports `FAIL`, and `KMS providers` reports `PASS`. On `http://localhost:3000`, the public URL check warns that it does not use HTTPS; through the tunnel it passes. In production, run `eudiplo doctor --strict`, which fails on warnings too.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unresolved placeholder ${MEMBERSHIP_FILES_ADMIN_SECRET}` from `validate` | The variable is not set in this shell or CI job | Export it, or set a dummy value in CI. |
| The metadata does not list `membership`, and the backend log shows `Failed to import tenant` | A check of the backend refused a file, for example `Authorization server id 'built-in' is reserved` | Read the reason with `eudiplo logs --instance cookbook --service eudiplo --tail 200`. `eudiplo config operations` shows the resource that failed; the ones before it stay applied. Fix the file and restart. |
| The import fails with an unresolved placeholder | The variable is missing from `.eudiplo.env`, or you ran `restart` after adding it | Add it, then run `eudiplo up --instance cookbook`. |
| A file change has no effect | `CONFIG_IMPORT_MODE` is still `create`, or the resource was detached or changed through the API (`RESOURCE_DETACHED`, `STALE_GENERATION` in the log) | Set `upsert` and run `eudiplo up`; reattach the resource ([Configuration as code](../operate/configuration-as-code.md#configuration-model)). |
| A config command answers `401` | The token in `EUDIPLO_TOKEN` expired | Request a new token as in step 4. |

More symptoms are listed in [Troubleshooting](../troubleshooting.md).

## Next steps

- Roll the folder out to another instance, such as the one from [Production on one VM](production-vm.md): copy `config/membership-files` into its `config/` folder, add `MEMBERSHIP_FILES_ADMIN_SECRET` with a new value to its `.eudiplo.env`, set `CONFIG_IMPORT_MODE=upsert` and run `eudiplo up --instance production`. The key chain gets a new key there. That backend must run the same EUDIPLO release as this one or a newer one, because an older backend refuses newer file format versions.
- Move a tenant you built in the Web Client to another instance with a bundle and a reviewed plan: [Plan and import](../operate/configuration-as-code.md#plan-and-import).
- Upgrade the instance and your files after a release: [Upgrade the application](../operate/cli.md#upgrade-the-application) and [Upgrade old files](../operate/configuration-as-code.md#upgrade-old-files).
