---
title: Object Storage
---

# Object Storage

Configure where EUDIPLO stores uploaded files: credential images, logos and the
`images/` of imported tenant configurations. Use the local filesystem for a
single backend, and S3-compatible storage (RustFS in the bundled stacks, AWS S3
or another provider) when several replicas run or the data must live outside the
host.

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="storage" />

## Local storage

```env
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=/app/uploads   # default: <FOLDER>/uploads
```

Each file is stored under a random UUID, with a `<uuid>.meta` file for its
content type. Put the directory on a persistent volume and include it in your
backups. Replicas cannot share it.

## S3-compatible storage

```env
STORAGE_DRIVER=s3
S3_REGION=eu-central-1
S3_BUCKET=eudiplo-files
# For RustFS or other S3-compatible services:
S3_ENDPOINT=http://rustfs:9000
S3_FORCE_PATH_STYLE=true
# Static credentials; omit both to use the AWS SDK default chain (IAM role, IRSA)
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
```

At startup, the backend sends a `HeadObject` request for a key that does not
exist. A "not found" answer proves access; any other error (credentials, bucket,
region, network) stops the startup with a message. The check needs object-level
read permission only, not `s3:ListBucket`.

The bucket does not have to be public: wallets and browsers download files
through the backend. Every write sets the `public-read` ACL: uploads through the
API and the images imported from tenant config folders and configuration
bundles. If your bucket has ACLs disabled (on AWS the default object ownership
*Bucket owner enforced*), these writes fail with `AccessControlListNotSupported`,
so uploads and imports that contain images fail; allow ACLs on the bucket or use
a provider that ignores them. The bundled
`rustfs-init` job creates `S3_BUCKET` and grants anonymous `s3:GetObject`;
remove that policy if the bucket must stay private.

**Checkpoint:** upload an image in the web client (for example a credential
logo) and open its URL.

## How files are served

| Endpoint              | Access                                          | Purpose                                                          |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `POST /api/storage`   | `issuance:manage`, multipart field `file`, up to 5 MB | Upload a file for the token's tenant; returns key and URL |
| `GET /storage/:key`   | public                                          | Download; the URL is `<PUBLIC_URL>/storage/<key>`                |

Downloads are public because wallets fetch logos and credential images without
credentials. A file is protected only by its random key, so do not store
confidential content. The mapping of keys to tenants and file names is kept in
the database; deleting a tenant deletes its files.

To move to another storage driver, copy the objects with their keys (for local
storage the files and their `.meta` files) and switch the variables. Moving
existing MinIO data to RustFS is described in the
[upgrade guide](../upgrade/8.x-to-9.0.md#bundled-object-storage-minio-replaced-by-rustfs).
