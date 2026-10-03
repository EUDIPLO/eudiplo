---
title: Docker Compose
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - trim to a short 'Compose without the CLI'; the CLI-driven setup lives in cookbooks/production-vm.md
-->

# Docker Compose Deployment

Deploy EUDIPLO using Docker Compose for local development, testing, and small-scale deployments.

## Quick Start

From the repository root:

```bash
# Create environment file
cp .env.example .env

# Start services
docker compose up -d

# Access the API
curl http://localhost:3000/health
```

Access points:

- **Backend API**: [http://localhost:3000/api](http://localhost:3000/api)
- **Client UI**: [http://localhost:4200](http://localhost:4200)

For the complete Docker Compose deployment guide including minimal, standard, and full presets, see the [Server Setup Cookbook](../cookbooks/production-vm.md).

## Deployment Presets

EUDIPLO offers three Docker Compose deployment options:

| Preset       | Database   | Storage            | Key Management  | Production Ready |
| ------------ | ---------- | ------------------ | --------------- | ---------------- |
| **Minimal**  | SQLite     | Local filesystem   | Database-backed | ⚠️ Limited       |
| **Standard** | PostgreSQL | S3 via local RustFS | Database-backed | ✅ Yes (small)   |
| **Full**     | PostgreSQL | S3 via local RustFS | Vault           | ✅ Yes           |

## Environment Variables

Essential configuration for all presets:

```env
# Public URL (for OAuth redirects)
PUBLIC_URL=http://localhost:3000

# Internal backend URL for self-JWKS verification (default shown)
# Change only when the backend is not listening on port 3000 in this container.
INTERNAL_URL=http://127.0.0.1:3000

# Environment
NODE_ENV=production

# Application Secrets
MASTER_SECRET=your-secret-jwt-key-change-in-production
AUTH_CLIENT_ID=your-client-id
AUTH_CLIENT_SECRET=your-client-secret
```

:::danger[Security Warning]
**Never use default credentials in production!** Change all passwords, tokens, and secrets before deploying.
:::

## Full Deployment Configuration

For production deployments with PostgreSQL, RustFS, and optional Vault:

```env
# PostgreSQL Configuration
DB_TYPE=postgres
DB_HOST=database
DB_PORT=5432
DB_USERNAME=eudiplo_user
DB_PASSWORD=strong-secure-password-here
DB_DATABASE=eudiplo

# RustFS (S3-compatible storage)
RUSTFS_ACCESS_KEY=rustfsadmin
RUSTFS_SECRET_KEY=rustfsadmin-secure-password
```

## Service Management

View running services:

```bash
docker compose ps
```

View logs:

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f eudiplo
```

Restart a service:

```bash
docker compose restart eudiplo
```

Stop services:

```bash
docker compose down

# Remove all data (volumes)
docker compose down -v
```

## Related Topics

- [Server Setup Cookbook](../cookbooks/production-vm.md) — Detailed setup instructions
- [CLI Tool](./cli.md) — Deploy with EUDIPLO CLI
- [Kubernetes Deployment](kubernetes.md) — Production deployment on K8s
- [TLS Configuration](tls.md) — Enable HTTPS

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
