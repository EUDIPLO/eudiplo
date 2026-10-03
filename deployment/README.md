# Deployments

This directory contains deployment configurations for EUDIPLO with multiple profiles to match your infrastructure needs.

**📖 For comprehensive deployment documentation, visit:**  
**[https://docs.eudiplo.dev/operate/](https://docs.eudiplo.dev/operate/)**

## Deployment Options

### Docker Compose (Recommended for getting started)

| Profile      | Command                                | Components                   |
| ------------ | -------------------------------------- | ---------------------------- |
| **Minimal**  | `docker compose up`                    | EUDIPLO only                 |
| **Standard** | `docker compose --profile standard up` | + PostgreSQL + RustFS         |
| **Full**     | `docker compose --profile full up`     | + PostgreSQL + RustFS + Vault |

```bash
cd deployment/docker-compose
cp .env.standard.example .env
docker compose --profile standard up -d
```

### Kubernetes (Production)

| Overlay      | Command                              | Components                   |
| ------------ | ------------------------------------ | ---------------------------- |
| **Minimal**  | `kubectl apply -k overlays/minimal`  | EUDIPLO only                 |
| **Standard** | `kubectl apply -k overlays/standard` | + PostgreSQL + RustFS         |
| **Full**     | `kubectl apply -k overlays/full`     | + PostgreSQL + RustFS + Vault |

```bash
cd deployment/k8s
cp overlays/standard/.env.example overlays/standard/.env
kubectl create namespace eudiplo
kubectl -n eudiplo create secret generic eudiplo-env --from-env-file=overlays/standard/.env
kubectl apply -k overlays/standard
```

## Configuration Matrix

| Component          | Minimal          | Standard           | Full            |
| ------------------ | ---------------- | ------------------ | --------------- |
| **Database**       | SQLite           | PostgreSQL         | PostgreSQL      |
| **File Storage**   | Local filesystem | RustFS (S3)         | RustFS (S3)      |
| **Key Management** | DB-backed        | DB-backed          | HashiCorp Vault |
| **Use Case**       | Dev/Testing      | Staging/Small Prod | Enterprise Prod |

## Directory Structure

```
deployment/
├── docker-compose/          # Docker Compose deployments
│   ├── docker-compose.yml   # Multi-profile compose file
│   ├── .env.minimal.example
│   ├── .env.standard.example
│   └── .env.full.example
│
├── k8s/                     # Kubernetes deployments
│   ├── base/               # Core manifests
│   ├── components/         # Optional components (postgres, rustfs, vault)
│   └── overlays/           # Pre-configured profiles
```

## Quick Reference

| Deployment         | Path                    | Documentation                                                                                                  | Use Case      |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| **Quick Start**    | `../docker-compose.yml` | [Docker Compose Guide](https://docs.eudiplo.dev/operate/docker-compose/) | Quick testing |
| **Docker Compose** | `docker-compose/`       | [Docker Compose Guide](https://docs.eudiplo.dev/operate/docker-compose/) | Development   |
| **Kubernetes**     | `k8s/`                  | [Kubernetes Guide](https://docs.eudiplo.dev/operate/kubernetes/)         | Production    |

## Service Access

After deployment, access the services at:

| Service               | URL                                     |
| --------------------- | --------------------------------------- |
| **Backend API**       | <http://localhost:3000>                 |
| **Client Web UI**     | <http://localhost:4200>                 |
| **API Documentation** | <http://localhost:3000/api-docs>        |
| **RustFS Console**     | <http://localhost:9001/rustfs/console/> (standard/full) |
| **Vault UI**          | <http://localhost:8200> (full)          |

## Support

- **Documentation:** [https://docs.eudiplo.dev/](https://docs.eudiplo.dev/)
- **Issues:** [GitHub Issues](https://github.com/openwallet-foundation/eudiplo/issues)
- **Community:** [Discord](https://discord.gg/58ys8XfXDu)
