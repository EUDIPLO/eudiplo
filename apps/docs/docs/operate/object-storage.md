---
title: Storage
---

# Storage

EUDIPLO requires persistent file storage for:

- Files uploaded by a tenant, such as credential images and logos
- Images restored from configuration bundles or imported from a tenant's `images/` config folder

Storage is abstracted through a pluggable `FileStorage` interface, allowing deployments to use local filesystem storage during development and S3-compatible object storage in production.

## Configuration

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="storage" />

## Local Storage

Uses the server's local filesystem. Every file is stored directly under the configured directory with a random UUID as its key. When a content type is known, it is kept in a `.meta` sidecar file:

```text
LOCAL_STORAGE_DIR/
  <uuid>          # file content
  <uuid>.meta     # {"contentType": "image/png"}
```

**Environment Variables:**

```bash
STORAGE_DRIVER=local                  # default
LOCAL_STORAGE_DIR=/app/config/uploads # default: <FOLDER>/uploads
```

**Use when:** Development, single-node deployments, or when network storage is unavailable.

**Limitations:**

- Not suitable for multi-instance deployments (no shared state)
- Manual backup required
- Limited scalability

## S3 Storage

Uses S3-compatible object storage (AWS S3, RustFS, Azure Blob Storage via S3 API, Google Cloud Storage with S3 interop).

**Environment Variables:**

```bash
STORAGE_DRIVER=s3
S3_REGION=eu-central-1                                # required
S3_BUCKET=eudiplo-storage                             # required
S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com     # optional, for S3-compatible services
S3_ACCESS_KEY_ID=<your-access-key>                    # optional
S3_SECRET_ACCESS_KEY=<your-secret-key>                # optional
S3_FORCE_PATH_STYLE=false  # Set to true for RustFS
```

`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are optional. When both are set they are used as static credentials; otherwise the AWS SDK's default credential provider chain is used (for example IRSA or an instance profile).

At startup, EUDIPLO verifies S3 access by sending a `HeadObject` request for a key that is not expected to exist. A "not found" response means authentication works; any other error (invalid credentials, access denied, wrong bucket or region, network) stops the startup with a clear error. The check only needs object-level permissions, not `s3:ListBucket`.

Files uploaded through the API are written with the `public-read` ACL; files stored as private get no ACL.

**Use when:** Production deployments, multi-instance horizontally scaled setups, managed cloud infrastructure.

**Benefits:**

- Shared storage across all EUDIPLO instances
- Built-in durability and replication
- Managed backup and lifecycle policies
- No single point of failure

## Extensibility

To add a new storage backend (e.g., Azure Blob Storage native API, Google Cloud Storage), implement the `FileStorage` interface from `storage.types.ts`:

```typescript
export interface FileStorage {
    put(key: string, body: Buffer | Readable, opts?: PutOptions): Promise<void>;

    getStream(
        key: string,
    ): Promise<{ stream: Readable; contentType?: string; size?: number }>;

    delete(key: string): Promise<void>;

    exists(key: string): Promise<boolean>;
}
```

The existing adapters are `LocalFileStorage` and `S3FileStorage`. The active adapter is provided under the `FILE_STORAGE` token by the factory in `StorageModule.forRoot()`, which selects it based on `STORAGE_DRIVER`:

```typescript
providers: [
  FilesService,
  {
    provide: FILE_STORAGE,
    inject: [ConfigService],
    useFactory: async (cfg: ConfigService): Promise<FileStorage> => {
      const driver = cfg.get<Driver>("STORAGE_DRIVER");
      if (driver === "azure-blob") {
        return new AzureBlobFileStorage(cfg);
      }
      // ... existing drivers
    },
  },
],
```

Also add the new driver value to `STORAGE_DRIVER` in `storage-validation.schema.ts`.

## Accessibility

Storage keys are flat random UUIDs without a tenant prefix. The mapping of a key to its tenant and original file name is kept in the database (`FileEntity`: `id`, `filename`, `tenantId`).

Files are served by `GET /storage/:key`. This endpoint is **intentionally public** (no authentication), because wallets download credential images and logos from it. A file is protected only by its unguessable key; anyone who knows the URL can download it. Do not store confidential content in file storage.

## Multi-Tenant Storage

Tenant scoping is enforced when files are written and managed, not when they are downloaded:

- Uploads via `POST /api/storage` (multipart field `file`) require an authenticated token with the `issuance:manage` role. The file is recorded for the caller's tenant and the response returns the key and its public URL (`<PUBLIC_URL>/storage/<key>`).
- Images from configuration imports are recorded per tenant by file name. When a credential or issuance configuration references an image by file name, it is resolved to the public URL of that tenant's file.
- Deleting a tenant deletes all files recorded for that tenant.

### Example: Storing an uploaded file

```typescript
// FilesService.saveUserUpload
const key = randomUUID();
await this.storage.put(key, file.buffer, {
    contentType: file.mimetype,
    acl: isPublic ? "public" : "private",
    metadata: { originalName: file.originalname },
});
await this.fileRepository.save({
    id: key,
    filename: file.originalname,
    tenantId,
});
```
