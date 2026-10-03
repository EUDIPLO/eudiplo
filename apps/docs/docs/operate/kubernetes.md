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
- The [ingress-nginx](https://kubernetes.github.io/ingress-nginx/deploy/) controller:
  the bundled ingress sets `ingressClassName: nginx`
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

The base manifests reference an old release tag. Set the version you want to run
in your overlay's `kustomization.yaml`, and keep backend and web client on the
same version:

```yaml title="overlays/standard/kustomization.yaml"
images:
  - name: ghcr.io/openwallet-foundation/eudiplo
    newTag: "9.0.0"
  - name: ghcr.io/openwallet-foundation/eudiplo-client
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

The `full` overlay additionally needs `VAULT_TOKEN` in the secret. Its bootstrap
job writes a random encryption key to the development Vault, and the backend
starts with `ENCRYPTION_KEY_SOURCE=vault`.

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
  - name: ghcr.io/openwallet-foundation/eudiplo
    newTag: "9.0.0"
  - name: ghcr.io/openwallet-foundation/eudiplo-client
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
| Ingress returns 404                       | No `nginx` ingress class in the cluster                    | Install ingress-nginx or change `spec.ingressClassName`                             |
| Backend cannot reach PostgreSQL           | Database not ready or wrong credentials in the secret      | `kubectl -n eudiplo exec statefulset/postgres -- pg_isready`, then fix the secret and restart |
| Pods run an unexpected version            | Base manifests still on their default tag                  | Set `images:` in the overlay ([step 2](#2-pin-the-image-version))                   |
| `kubectl` reports an expired certificate for `127.0.0.1:6443` | Docker Desktop's local cluster certificate expired | Reset Kubernetes in Docker Desktop settings                                       |

## Migrating existing MinIO storage

Since 9.0 the bundled object storage is RustFS instead of MinIO, with a new
`rustfs-data` volume; follow the [upgrade guide](../upgrade/index.md) to move
existing objects.
