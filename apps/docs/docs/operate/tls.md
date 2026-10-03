---
title: TLS Configuration
---

# TLS/HTTPS Configuration

EUDIPLO supports built-in TLS termination, allowing you to serve HTTPS directly from the application without requiring a reverse proxy.

## Overview

| Method            | Best For                        | Complexity  | Recommendation               |
| ----------------- | ------------------------------- | ----------- | ---------------------------- |
| **Built-in TLS**  | Simple deployments, development | ⭐ Easy     | Small-scale, single instance |
| **Reverse Proxy** | Production, load balancing      | ⭐⭐ Medium | Large-scale, multi-instance  |

## Built-in TLS Configuration

### Environment Variables

import ConfigTable from "@site/src/components/ConfigTable";

<ConfigTable group="tls" />

### Basic Setup

#### 1. Generate or obtain TLS certificates

For development, you can generate a self-signed certificate:

```bash
# Generate a self-signed certificate valid for 365 days
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
    -subj "/CN=localhost"
```

For production, use certificates from a trusted Certificate Authority (CA) like Let's Encrypt.

#### 2. Configure environment variables

Add the following to your `.env` file:

```bash
TLS_ENABLED=true
TLS_CERT_PATH=/path/to/cert.pem
TLS_KEY_PATH=/path/to/key.pem

# Update PUBLIC_URL to use HTTPS
PUBLIC_URL=https://your-domain.com:3000
```

#### 3. Start the application

The application will automatically use HTTPS when TLS is enabled.

### Docker Compose Example

Mount your certificates as volumes:

```yaml
services:
    eudiplo:
        image: ghcr.io/openwallet-foundation/eudiplo:latest
        ports:
            - "3000:3000"
        environment:
            TLS_ENABLED: "true"
            TLS_CERT_PATH: /certs/cert.pem
            TLS_KEY_PATH: /certs/key.pem
            PUBLIC_URL: https://your-domain.com:3000
        volumes:
            - ./certs:/certs:ro
```

### Using Let's Encrypt Certificates

When using Let's Encrypt certificates (e.g., via Certbot):

```bash
TLS_ENABLED=true
TLS_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem
```

:::tip[Certificate Renewal]
Let's Encrypt certificates expire every 90 days. Set up automatic renewal with Certbot and restart the application after renewal to pick up new certificates.
:::

### With CA Certificate Chain

For mutual TLS (mTLS) or when you need to verify client certificates:

```bash
TLS_ENABLED=true
TLS_CERT_PATH=/path/to/cert.pem
TLS_KEY_PATH=/path/to/key.pem
TLS_CA_PATH=/path/to/ca-chain.pem
```

### With Encrypted Private Key

If your private key is encrypted with a passphrase:

```bash
TLS_ENABLED=true
TLS_CERT_PATH=/path/to/cert.pem
TLS_KEY_PATH=/path/to/encrypted-key.pem
TLS_KEY_PASSPHRASE=your-key-passphrase
```

## Reverse Proxy Alternative

For production deployments with multiple instances or advanced load balancing, consider using a reverse proxy:

### Nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Modern TLS configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Traefik Example (Docker Compose)

```yaml
services:
    traefik:
        image: traefik:v3.0
        command:
            - "--providers.docker=true"
            - "--entrypoints.websecure.address=:443"
            - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"
            - "--certificatesresolvers.letsencrypt.acme.email=your-email@example.com"
            - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
        ports:
            - "443:443"
        volumes:
            - "/var/run/docker.sock:/var/run/docker.sock:ro"
            - "letsencrypt:/letsencrypt"

    eudiplo:
        image: ghcr.io/openwallet-foundation/eudiplo:latest
        labels:
            - "traefik.enable=true"
            - "traefik.http.routers.eudiplo.rule=Host(`your-domain.com`)"
            - "traefik.http.routers.eudiplo.entrypoints=websecure"
            - "traefik.http.routers.eudiplo.tls.certresolver=letsencrypt"
        environment:
            PUBLIC_URL: https://your-domain.com

volumes:
    letsencrypt:
```

## Serving the Client from a Subpath

When serving the EUDIPLO client behind a reverse proxy on a subpath (e.g., `https://example.com/eudiplo-client/`), two things are required:

1. **Set `CLIENT_BASE_HREF`** on the client container so Angular resolves routes and assets correctly.
2. **Configure the reverse proxy** to forward the subpath to the client container.

:::warning[Backend Subpath Not Supported]
Only the **client** can be served from a subpath. The backend (OID4VCI/OID4VP endpoints) must be served from the root of its hostname, because the OID4VCI specification interprets path segments as tenant identifiers.
:::

### Client Container Configuration

```yaml
services:
    eudiplo-client:
        image: ghcr.io/openwallet-foundation/eudiplo-client:latest
        environment:
            API_BASE_URL: http://eudiplo:3000
            CLIENT_BASE_HREF: /eudiplo-client/
```

:::note[Automatic Normalization]
The `CLIENT_BASE_HREF` value is automatically normalized to ensure it starts and ends with `/`. For example, `eudiplo-client` becomes `/eudiplo-client/`.
:::

## Related Topics

- [Docker Compose Deployment](docker-compose.md) — Deploy with Docker
- [Kubernetes Deployment](kubernetes.md) — Deploy on K8s
- [Authentication](tenants-and-access.md#api-authentication) — Secure API access
