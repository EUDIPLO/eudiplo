---
title: Kubernetes
---

# Kubernetes

Deploy EUDIPLO to a cluster with the Kustomize overlays in `deployment/k8s`.
The overlays are a starting point: each workload runs one replica, and the
bundled PostgreSQL, RustFS and Vault are single-instance development services.
For production, keep the base manifests and point EUDIPLO at a managed database,
object store and secret store.

## Before you start

- `kubectl` with access to the cluster, and a storage class for persistent volumes
- An ingress controller of your choice. The bundled `Ingress`
  (`base/ingress.yaml`) uses the class `nginx`; set `spec.ingressClassName` to
  your controller's class (`kubectl get ingressclass`). The Kubernetes project
  retired ingress-nginx in March 2026. With the Gateway API, route your
  `HTTPRoute`s to the services `eudiplo` (port 3000) and `eudiplo-client`
  (port 80), and remove the `Ingress` in your overlay with a `$patch: delete`
  patch.
- A choice of overlay: `minimal`, `standard` or `full` (see
  [presets and profiles](index.md#presets-and-profiles))

The `minimal` overlay mounts `/app/config` as an `emptyDir`, so the SQLite
database is lost when the pod restarts. Use it for short tests only.

## 1. Create the namespace and secret

```bash
cd deployment/k8s
cp overlays/standard/.env.example overlays/standard/.env
# Replace MASTER_SECRET, AUTH_CLIENT_SECRET, DB_PASSWORD and the RustFS/S3 keys

kubectl create namespace eudiplo
kubectl -n eudiplo create secret generic eudiplo-env \
  --from-env-file=overlays/standard/.env
```

The backend reads every variable from the `eudiplo-env` secret. `DB_HOST`,
`DB_PORT` and `S3_ENDPOINT` are set by the `postgres` and `rustfs` components.
To change a value later, recreate the secret with
`--dry-run=client -o yaml | kubectl apply -f -` and restart the deployment.

## 2. Pin the image version

The base manifests pin `9.0.0`; releases don't update that tag. Set the version
you want to run in your overlay's `kustomization.yaml`, and keep backend and web
client on the same version:

```yaml title="overlays/standard/kustomization.yaml"
images:
  - name: ghcr.io/eudiplo/eudiplo
    newTag: "9.0.0"
  - name: ghcr.io/eudiplo/eudiplo-client
    newTag: "9.0.0"
```

Release images are tagged `X.Y.Z`, `X.Y`, `X` and `latest`; `main` and
`sha-<commit>` are builds of the main branch. For reproducible deployments use
`X.Y.Z` or an image digest (`digest: sha256:…` instead of `newTag`). The web
client shows a warning banner when it and the backend come from different
builds.

To upgrade later, back up the database, change `newTag` for both images, and
apply the overlay again. The new backend runs the database migrations on start;
with more than one replica, let one replica finish the migration before scaling
up ([Database](database.md#migrations)). Read the
[upgrade guide](../upgrade/index.md) for every major version you cross.

## 3. Apply the overlay

```bash
kubectl apply -k overlays/standard
kubectl -n eudiplo get pods -w
```

The `full` overlay additionally needs `VAULT_TOKEN` in the secret; see
[below](#encryption-key-in-the-bundled-vault-full).

**Checkpoint:** all pods are `Running`, the `rustfs-bucket-bootstrap` job is
`Completed`, and the health endpoint answers:

```bash
curl http://eudiplo.localtest.me/health
```

```json
{
    "status": "ok",
    "info": { "database": { "status": "up" } },
    "error": {},
    "details": { "database": { "status": "up" } }
}
```

`/health` checks only the database connection. The running version is returned
by the authenticated `GET /api/version`.

### Encryption key in the bundled Vault (`full`)

The `vault-bootstrap` job of the `full` overlay writes a random encryption key
to the bundled Vault if none exists. The backend runs with
`ENCRYPTION_KEY_SOURCE=vault`; its init container `wait-for-vault` holds it
back until the key exists.

The bundled Vault runs in development mode and keeps everything in memory.
When the `vault` pod restarts, the key is gone: running backend pods keep
working, new ones wait in `wait-for-vault`. Save the key after the first start
(use the `VAULT_TOKEN` of your secret instead of `root`):

```bash
kubectl -n eudiplo exec deploy/vault -- env VAULT_ADDR=http://127.0.0.1:8200 \
  VAULT_TOKEN=root vault kv get -field=key secret/eudiplo/encryption-key
```

After a Vault restart, write the saved key back the same way with
`vault kv put secret/eudiplo/encryption-key key=<saved key>`. Don't delete and
re-run the bootstrap job instead: it would create a new key, and the data
encrypted with the old one could no longer be decrypted. Use `full` only to
evaluate Vault. In production, use a Vault with persistent storage or another
[key source](encryption-keys.md#choose-a-key-source), and back up the key.

## Access the services

The ingress routes `eudiplo.localtest.me` to the backend and
`eudiplo-client.localtest.me` to the web client; `localtest.me` resolves to
`127.0.0.1`. Change the hosts in `base/ingress.yaml` (or patch them in your
overlay) and set `PUBLIC_URL` to the public backend URL. TLS termination is
covered in [TLS and reverse proxy](tls.md).

Without an ingress, forward the ports:

```bash
kubectl -n eudiplo port-forward svc/eudiplo 3000:3000
kubectl -n eudiplo port-forward svc/eudiplo-client 4200:80
```

## Use managed services

Create your own overlay that includes only `../../base` and set the connection
variables in the secret instead of adding the `postgres`, `rustfs` or `vault`
components:

```yaml title="overlays/production/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: eudiplo
resources:
  - ../../base
images:
  - name: ghcr.io/eudiplo/eudiplo
    newTag: "9.0.0"
  - name: ghcr.io/eudiplo/eudiplo-client
    newTag: "9.0.0"
```

The variables are described in [Database](database.md),
[Object storage](object-storage.md), [Encryption keys](encryption-keys.md) and
[KMS](kms.md). The base deployment mounts `/app/config` as an `emptyDir`; mount
a ConfigMap or volume there if you use a global `kms.json` or tenant config
folders.

## Manage the deployment with the CLI

Register the cluster as a `kubernetes` instance to run `eudiplo doctor`,
`ps`, `logs` and `restart` against it. The CLI never applies manifests; see
[CLI: Kubernetes instances](cli.md#kubernetes-instances) for registration and
the required RBAC permissions.

## Troubleshooting

| Symptom                                   | Cause                                                      | Fix                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Pod in `CrashLoopBackOff` right after start | Missing `MASTER_SECRET`, `AUTH_CLIENT_ID` or `AUTH_CLIENT_SECRET`, or an invalid variable | `kubectl -n eudiplo logs deployment/eudiplo` shows the validation error             |
| Ingress gets no address, or requests answer 404 | No ingress controller serves the class `nginx`       | Set `spec.ingressClassName` to a class from `kubectl get ingressclass`              |
| Backend cannot reach PostgreSQL           | Database not ready or wrong credentials in the secret      | `kubectl -n eudiplo exec statefulset/postgres -- pg_isready`, then fix the secret and restart |
| `ErrImagePull` or `ImagePullBackOff`      | The image tag does not exist; release tags have no `v` prefix | `kubectl -n eudiplo describe pod <pod>` shows the image; correct `newTag` in `images:` ([step 2](#2-pin-the-image-version)) |
| Pods run an older version than expected   | The overlay sets no `images:`, so the base tag `9.0.0` is used | Set `images:` in the overlay ([step 2](#2-pin-the-image-version))                |
| `kubectl apply` fails with `field is immutable` for a Job | The job's template changed in newer manifests | Delete the completed job (`kubectl -n eudiplo delete job <name>`) and apply again. `vault-bootstrap` keeps an existing key; after a Vault restart, [restore the key](#encryption-key-in-the-bundled-vault-full) first |
| `kubectl` reports an expired certificate for `127.0.0.1:6443` | Docker Desktop's local cluster certificate expired | Reset Kubernetes in Docker Desktop settings                                       |

## Migrating existing MinIO storage

Since 9.0 the bundled object storage is RustFS instead of MinIO, with a new
`rustfs-data` volume; follow the
[upgrade guide](../upgrade/8.x-to-9.0.md#bundled-object-storage-minio-replaced-by-rustfs)
to move existing objects.
