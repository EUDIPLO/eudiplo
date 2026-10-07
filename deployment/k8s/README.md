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
| **Full**     | `kubectl apply -k overlays/full`     | + PostgreSQL, RustFS, Vault | Evaluation (dev-mode Vault) |

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

The bundled `Ingress` uses the class `nginx`; set `spec.ingressClassName` to the
class of your ingress controller (`kubectl get ingressclass`).

## Configuration Matrix

| Component          | Minimal   | Standard   | Full       |
| ------------------ | --------- | ---------- | ---------- |
| **Database**       | SQLite    | PostgreSQL | PostgreSQL |
| **File Storage**   | Local     | RustFS (S3) | RustFS (S3) |
| **Encryption key** | From `MASTER_SECRET` | From `MASTER_SECRET` | Vault (dev mode, in memory) |

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

The full overlay deploys Vault in development mode, which keeps everything in
memory. Its bootstrap job creates the encryption key if none exists; when the
Vault pod restarts, the key is gone and must be restored from a backup, never
recreated. Use an externally managed, initialized Vault instance with a
restricted token for production. See
[Kubernetes](https://docs.eudiplo.dev/operate/kubernetes#encryption-key-in-the-bundled-vault-full).

👉 **[Read the full documentation](https://docs.eudiplo.dev/operate/kubernetes/)**

## Migrating existing MinIO storage

These manifests deploy RustFS 1.0.0 with a separate `rustfs-data` PVC. Existing
MinIO data is not migrated automatically; do not mount a MinIO data directory
into RustFS. The steps are in the
[upgrade guide](https://docs.eudiplo.dev/upgrade/8.x-to-9.0#bundled-object-storage-minio-replaced-by-rustfs).

The bucket initialization job uses AWS CLI 2.34.0 and retains the previous
public-download policy (`s3:GetObject`). Review that policy for private buckets.
