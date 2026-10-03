# Kubernetes Deployments

This directory contains Kubernetes manifests for EUDIPLO using Kustomize for flexible, composable deployments.

📚 **Full documentation:** [https://docs.eudiplo.dev/operate/kubernetes/](https://docs.eudiplo.dev/operate/kubernetes/)

## Directory Structure

```
k8s/
├── base/                    # Core EUDIPLO manifests
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── eudiplo-deployment.yaml
│   ├── eudiplo-service.yaml
│   ├── eudiplo-client-deployment.yaml
│   ├── eudiplo-client-service.yaml
│   └── ingress.yaml
│
├── components/              # Optional infrastructure components
│   ├── postgres/           # PostgreSQL database
│   ├── rustfs/              # RustFS S3-compatible storage
│   └── vault/              # HashiCorp Vault key management
│
└── overlays/               # Pre-configured deployment profiles
    ├── minimal/            # EUDIPLO only (SQLite, local storage)
    ├── standard/           # + PostgreSQL + RustFS
    └── full/               # + PostgreSQL + RustFS + Vault
```

## Quick Start

### 1. Choose Your Overlay

| Overlay      | Command                              | Components                 | Use Case            |
| ------------ | ------------------------------------ | -------------------------- | ------------------- |
| **Minimal**  | `kubectl apply -k overlays/minimal`  | EUDIPLO only               | Local dev, testing  |
| **Standard** | `kubectl apply -k overlays/standard` | + PostgreSQL, RustFS        | Staging, small prod |
| **Full**     | `kubectl apply -k overlays/full`     | + PostgreSQL, RustFS, Vault | Enterprise prod     |

### 2. Configure and Deploy

```bash
# Navigate to the k8s directory
cd deployment/k8s

# Choose your overlay and copy its example env
cp overlays/standard/.env.example overlays/standard/.env
# Edit with your configuration
nano overlays/standard/.env

# Create namespace and secret
kubectl create namespace eudiplo
kubectl -n eudiplo create secret generic eudiplo-env --from-env-file=overlays/standard/.env

# Deploy using Kustomize
kubectl apply -k overlays/standard

# Watch the deployment
kubectl -n eudiplo get pods -w
```

### 3. Access Services

- **Backend API:** http://eudiplo.localtest.me
- **Client UI:** http://eudiplo-client.localtest.me
- **RustFS Console:** http://rustfs-console.localtest.me/rustfs/console/ (standard/full)

## Configuration Matrix

| Component          | Minimal   | Standard   | Full       |
| ------------------ | --------- | ---------- | ---------- |
| **Database**       | SQLite    | PostgreSQL | PostgreSQL |
| **File Storage**   | Local     | RustFS (S3) | RustFS (S3) |
| **Key Management** | DB-backed | DB-backed  | Vault      |

## Customizing Deployments

### Mix-and-Match Components

Create a custom overlay by combining components:

```yaml
# k8s/overlays/custom/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base

namespace: eudiplo

components:
  - ../../components/postgres
  # Only include what you need
  # - ../../components/rustfs
  # - ../../components/vault
```

### Override Values

Add patches in your overlay to customize resources:

```yaml
# k8s/overlays/custom/kustomization.yaml
patches:
  - target:
      kind: Deployment
      name: eudiplo
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 3
```

## Legacy Manifests

The flat manifest files in this directory are kept for backwards compatibility.
New deployments should use the overlay system described above.

| File                        | Purpose              |
| --------------------------- | -------------------- |
| `namespace.yaml`            | Namespace definition |
| `postgres-statefulset.yaml` | PostgreSQL database  |
| `rustfs-statefulset.yaml`    | RustFS object storage |
| `eudiplo-deployment.yaml`   | Backend deployment   |
| `ingress.yaml`              | Ingress routing      |

## Troubleshooting

```bash
# Check pod status
kubectl -n eudiplo get pods
kubectl -n eudiplo describe pod <pod-name>
kubectl -n eudiplo logs <pod-name>

# Port forward for testing
kubectl -n eudiplo port-forward svc/eudiplo 3000:3000
```

## Production Considerations

⚠️ **Before deploying to production:**

1. **Change all default credentials**
2. **Use external managed services** (RDS, S3, Vault)
3. **Enable TLS** via cert-manager
4. **Configure resource limits**
5. **Set up monitoring** (Prometheus, Grafana)
6. **Pin application images** to a tested release or digest before upgrading

The full overlay deploys Vault in development mode and creates its encryption key
automatically. Use an externally managed, initialized Vault instance with a
restricted token for production.

👉 **[Read the full documentation](https://docs.eudiplo.dev/operate/kubernetes/)**

## Migrating existing MinIO storage

These templates now deploy RustFS 1.0.0 with a separate `rustfs-data` volume
(or PVC). Existing MinIO data is not migrated automatically. Keep the old
volumes and backups; do not mount a MinIO data directory directly into RustFS.

1. Start RustFS with an empty volume alongside the existing storage service.
2. Copy buckets and objects through the S3 API using a migration tool that
   preserves the metadata, versions, and policies your deployment requires.
3. Verify object counts, contents, and application reads before switching
   `S3_ENDPOINT` to `http://rustfs:9000`.
4. Replace `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` with `RUSTFS_ACCESS_KEY` /
   `RUSTFS_SECRET_KEY`, and use the same values for `S3_ACCESS_KEY_ID` /
   `S3_SECRET_ACCESS_KEY`. Bucket initialization now uses `S3_BUCKET`.
5. Keep the old service and data available for rollback until the migration
   is verified. Existing CLI projects need their Compose file and `.env`
   updated as well; updating the CLI alone does not rewrite them.

The bucket initialization job uses AWS CLI 2.34.0 and retains the previous
public-download policy (`s3:GetObject`). Review that policy for private buckets.
