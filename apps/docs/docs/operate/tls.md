---
title: TLS and Reverse Proxy
---

# TLS and Reverse Proxy

Serve EUDIPLO over HTTPS, either behind a TLS-terminating reverse proxy or with
the backend's built-in TLS. Wallets require HTTPS for every issuer and verifier
URL, so `PUBLIC_URL` must be the `https://` URL wallets reach.

| Option          | Use it when                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Reverse proxy   | Default. Certificate renewal, rate limits, IP filtering and the web client run in front of EUDIPLO |
| Built-in TLS    | No proxy is available, for example a single container on a test host                            |

## Behind a reverse proxy

The backend listens on plain HTTP (port 3000, or `PORT`). It builds every URL in
offers, metadata and redirects from `PUBLIC_URL` and does not read
`X-Forwarded-*` headers, so set `PUBLIC_URL` to the external URL:

```env
PUBLIC_URL=https://eudiplo.example.com
TLS_ENABLED=false
```

Requirements for the proxy:

- Serve the backend at the root of its host name. Tenant IDs are path segments
  of the protocol URLs (`/issuers/<tenant>/…`), so the backend cannot run under
  a path prefix. Only the [web client](#serving-the-client-from-a-subpath) can.
- Allow request bodies up to 50 MB if you import configuration ZIP bundles
  (`POST /api/config-bundles/import/archive`); other requests stay below 10 MB.
- Do not buffer server-sent events from `/api/session/:id/events`.
- Bind the backend port to `127.0.0.1` (Compose: `EUDIPLO_BIND_ADDRESS=127.0.0.1`)
  so it is only reachable through the proxy.

### Caddy

Caddy obtains and renews certificates automatically:

```text title="Caddyfile"
eudiplo.example.com {
    reverse_proxy 127.0.0.1:3000
}

console.example.com {
    reverse_proxy 127.0.0.1:4200
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name eudiplo.example.com;

    ssl_certificate     /etc/letsencrypt/live/eudiplo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eudiplo.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;   # session events (SSE)
        proxy_read_timeout 1h;
    }
}
```

When the web client runs on another origin than the backend, add that origin to
`CORS_ORIGINS` if you restrict browser access to the management API (see the
[production checklist](production-checklist.md#network-and-tls)).

## Built-in TLS

Set the certificate and key files; the backend then serves HTTPS on the same port:

```env
TLS_ENABLED=true
TLS_CERT_PATH=/certs/fullchain.pem
TLS_KEY_PATH=/certs/privkey.pem
PUBLIC_URL=https://eudiplo.example.com:3000
```

```yaml title="Compose override"
services:
    eudiplo:
        volumes:
            - ./certs:/certs:ro
```

Behavior since 9.0:

- **TLS fails closed.** With `TLS_ENABLED=true`, startup fails if `TLS_CERT_PATH`
  or `TLS_KEY_PATH` is unset, a file cannot be read, or a file contains no PEM
  certificate. The backend never falls back to plain HTTP.
- **`TLS_CA_PATH` adds intermediate certificates.** The certificates in that file
  are sent after the server certificate so clients can build the chain;
  certificates that `TLS_CERT_PATH` already contains are not added twice. You do
  not need it with a full chain such as Let's Encrypt's `fullchain.pem`. It does
  not enable client certificate authentication (mTLS).
- **Encrypted keys** need `TLS_KEY_PASSPHRASE`.
- Certificates are read at startup. Restart the backend after renewing them.

The startup log reports `TLS: Enabled`. The variables are listed under
[TLS](../reference/environment-variables.md#tls). For a quick local test, a
self-signed certificate works with `curl -k`; wallets reject it.

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout key.pem -out cert.pem -days 30 -subj "/CN=localhost"
```

## Serving the client from a subpath

The web client can run under a path, for example
`https://example.com/eudiplo-client/`. Two settings are needed:

1. Set `CLIENT_BASE_HREF` on the client container. The container rewrites the
   `<base href>` of the app at start, so routes and assets resolve under the
   path. The value is normalized to start and end with `/` and may only contain
   letters, digits, `-`, `_` and `/`.

   ```yaml
   services:
       eudiplo-client:
           image: ghcr.io/openwallet-foundation/eudiplo-client:latest
           environment:
               API_BASE_URL: https://eudiplo.example.com
               CLIENT_BASE_HREF: /eudiplo-client/
   ```

2. Make the proxy strip the path before forwarding, because the client container
   serves its files at `/`:

   ```text title="Caddyfile"
   example.com {
       handle_path /eudiplo-client/* {
           reverse_proxy 127.0.0.1:4200
       }
   }
   ```

   ```nginx
   location /eudiplo-client/ {
       proxy_pass http://127.0.0.1:4200/;   # trailing slash strips the prefix
   }
   ```

The backend itself cannot be served from a subpath (see above).
