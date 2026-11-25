---
title: Keep a Tenant in Git
---

# Keep a Tenant in Git

Export a tenant from a running instance as a
[tenant folder](../reference/config-bundle-format.md#tenant-folder-layout),
commit it, and plan and import changes to it from the folder. Bundles, plans and
ownership are explained in [Configuration as code](configuration-as-code.md);
this page uses the same commands and token
([Export a tenant](configuration-as-code.md#export-a-tenant)).

## Export the tenant as a folder

End `--output` with a slash, or name an existing empty directory:

```bash
eudiplo config export --instance production --output ./config/acme/
```

Any other `--output` writes a bundle file: JSON for `.json`, a ZIP otherwise,
also without an extension.

- **Names.** Files are named after the resource ID (`clients/<clientId>.json`,
  `key-chains/<id>.json`, `issuance/issuance.json`, …). An ID that is no valid
  file name on every system, that is longer than 80 characters or that differs
  from another only in case gets a short hash suffix; the ID inside the
  document is what counts.
- **Stable output.** Keys are sorted and indented by two spaces, so exporting
  the same configuration again writes the same files and `git diff` shows only
  real changes.
- **Secrets.** Placeholders and `keySource: { "type": "required" }` are written
  as the export has them. Instead of a `manifest.json`, the command lists each
  value to supply with its file:

  ```text
  2 value(s) to supply before this folder can be imported:
    clients/portal.json /spec/secret: ${CLIENT_PORTAL_SECRET} (CLIENT_SECRET_REQUIRED)
    key-chains/signing.json /spec/keySource: private key (PRIVATE_KEY_REQUIRED)
  ```

- **Target.** The directory must not exist or must be empty; the folder is
  written in full or not at all. Name it after the tenant: the startup import
  takes the tenant from the folder name, and a CLI import uses it as the
  bundle source.

## Plan and import the folder

`config plan` and `config import` take the folder in place of a bundle:

```bash
eudiplo config plan ./config/acme --instance staging --mode upsert --diff --output plan.json --allow-env PORTAL_SECRET
eudiplo config import ./config/acme --instance staging --mode upsert --plan plan.json --allow-env PORTAL_SECRET
```

1. The CLI validates the folder offline, like
   [`eudiplo config tenant validate`](configuration-as-code.md#validate-in-ci).
   A folder with errors exits with `1` and is not sent, and so is a folder
   with a symbolic link that points outside it or does not resolve.
2. It fills in `${VAR}` placeholders from the variables named in
   `--allow-env` (see below). A placeholder without a value is named in a
   warning and sent as it is; the plan blocks that resource with
   `SECRET_REQUIRED` until the variable is set and named. One inside a
   longer value is stored as text, and the plan warns with
   `PLACEHOLDER_STORED_AS_TEXT`. In the folder's
   `kms.json`, fill in every placeholder: the API accepts none there
   ([placeholders in a tenant `kms.json`](kms.md#placeholders-in-a-tenant-kmsjson)).
   It also refuses a new `pkcs11` provider, new mTLS files and a new `aws-kms`
   provider without credentials there
   ([files and AWS credentials in a tenant `kms.json`](kms.md#files-and-aws-credentials-in-a-tenant-kmsjson)),
   and a provider whose server the outbound URL policy refuses
   ([servers in a tenant `kms.json`](kms.md#servers-in-a-tenant-kmsjson)).
3. It sends the folder as a bundle archive, `info.json` and `images/` included.
   The bundle is the same for the same files and environment, so the import
   matches the reviewed plan.

The tenant comes from the access token, not from the folder name.

Planning a freshly exported folder against the same instance shows every
resource as `unchanged`, except those with a requirement: a client whose secret
is a placeholder is `blocked` with `SECRET_REQUIRED`, and a key chain with
`"type": "required"` with `PRIVATE_KEY_REQUIRED`, as when the bundle export
itself is planned.

## Placeholders and the CLI's environment

A placeholder can sit in any field, and the plan shows field values. So that a
change to the folder cannot copy a value out of the environment the CLI runs in,
for example a CI runner:

- `${VAR}` placeholders resolve only from the variables named in
  `--allow-env` (comma-separated). The CLI reads no other variable, and the
  option applies to a folder only. The server fills in no placeholder of a
  bundle it receives: the plan blocks a value that is only a placeholder with `SECRET_REQUIRED`
  ([placeholders and the API](../reference/config-bundle-format.md#placeholders-and-the-api)).
- `EUDIPLO_TOKEN`, `EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET` hold the
  CLI's own credentials and are refused in `--allow-env`.
- The plan or result that `config plan` and `config import` print or save,
  and an error the API answers, show each filled-in value as its placeholder
  again, in field values and messages; kinds, IDs and the plan fingerprint stay
  as they are. A value shorter than eight characters is only replaced where it
  is the whole value.

`config import` still stores the filled-in values: review which variables a
change adds to `--allow-env` before you import it. The startup import fills
placeholders from the backend's environment, except for the variables a file
cannot use
([variables a file can use](../reference/config-bundle-format.md#variables-a-file-can-use)).

## Folder imports and the startup import

Every import records its source on the resources it writes: a CLI import of a
folder `bundle:<folder name>`, the startup import the folder in
`CONFIG_FOLDER`. `replace` mode deletes only resources whose recorded source is
its own. If both import the same tenant, each takes over the resources it
writes: switching between them gives `!generate` clients a new secret, applies
unchanged key chains again (a `regenerate` key source gets new keys), and a
`replace` of one does not delete resources last written by the other. Manage a
tenant with one of the two.
