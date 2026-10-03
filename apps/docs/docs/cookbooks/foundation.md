---
title: Install and Connect
sidebar_label: Install and connect
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - add a short wallet/certificate decision box (owner: trust/wallet-registrars.md)
  - appended section 'Web Client' (from removed reference/web-client.md): fold the login steps into this cookbook
  - 'Web Client > Hosting from a Subpath' -> operate/tls.md
  - remaining 'Web Client' sections (dashboard, features, editing) -> drop or contributing/client.md
-->

This is chapter 1 of the [issuance and verification cookbook](index.md). By the end, the backend and Web Client will be running, and your phone will be able to reach the backend.

## Before you start

Install the standalone `eudiplo` CLI with:

```bash
curl -fsSL https://eudiplo.dev/install.sh | bash
```

Install Docker with Docker Compose, or Podman with Podman Compose. Start the runtime before running the commands below. The standalone `eudiplo` CLI does not require Node.js; if you use the npm package instead, install Node.js 22+ and replace `eudiplo` with `npx @eudiplo/cli`. Use an empty directory so this recipe does not replace another deployment.

## Step 1: Get an HTTPS address for the backend

A phone cannot use your computer's `localhost`: it would connect to the phone itself. Wallets also need to retrieve issuer metadata and send protocol responses to EUDIPLO.

Set up an HTTPS tunnel to local port **3000**. For example, install and authenticate the ngrok agent using its [quickstart](https://ngrok.com/docs/share-localhost/quickstart), then run:

```bash
ngrok http 3000
```

> There may be other alternatives to ngrok, such as Cloudflare Tunnel or localtunnel. Choose the one that best fits your environment. Keep in mind some free plans may have changing URLs or limited session durations. Deploying on your own server with Let's Encrypt is another option for a stable HTTPS endpoint.

Keep that terminal open. Copy the HTTPS forwarding URL; below, `https://YOUR-HTTPS-HOST` means that URL, without a trailing slash. A gateway error is expected until EUDIPLO starts.

Use this exact address for `PUBLIC_URL` from the beginning. Keep it unchanged through issuance and presentation: already-issued credentials can contain URLs pointing back to the issuer. If the address changes, update the deployment and issue a fresh test credential.

If you already have a reachable HTTPS backend, use that address and skip the local deployment commands. See [TLS configuration](../operate/tls.md) for a deployment without a tunnel.

## Step 2: Initialize and start EUDIPLO

In another terminal:

```bash
mkdir eudiplo-cookbook
cd eudiplo-cookbook
eudiplo init . --target compose --preset minimal --no-demo-tenant --client --public-url https://YOUR-HTTPS-HOST --yes --start
```

Replace `https://YOUR-HTTPS-HOST` before running the command. This creates a minimal deployment using SQLite, local storage, and database-backed keys, including the Web Client. It generates a root secret rather than using the predictable credentials from `demo` mode.

The editable deployment files include `eudiplo.compose.yaml`, `.eudiplo.env`, and `config/kms.json`. Keep `.eudiplo.env` private: it contains `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, and `MASTER_SECRET`.

**Expected result:** the backend listens on port `3000` and the Web Client is available at [http://localhost:4200](http://localhost:4200).

<details>
<summary>Only want to explore the UI locally?</summary>

Run `eudiplo demo` in a separate directory. This imports sample configuration and prints demo credentials. Keep that setup local; the cookbook uses the initialization command above so it can start without bundled tenants or predictable demo secrets.

</details>

## Step 3: Check both network paths

From the project directory:

```bash
eudiplo status
curl http://localhost:3000/health
curl https://YOUR-HTTPS-HOST/health
```

**Expected result:** the health response is JSON with `status` equal to `ok`. The exact health-check fields can vary.

Also open `https://YOUR-HTTPS-HOST/health` in the **phone's browser**. It must return the health response with no certificate warning, tunnel login, or HTML confirmation page. Do not proceed to QR codes until this works.

Use `http://localhost:4200` only in the browser on your computer to administer EUDIPLO. The wallet must not connect to the Web Client: it communicates only with the public backend address in `PUBLIC_URL`.

## Step 4: Sign in to the Web Client

1. Open [http://localhost:4200](http://localhost:4200).
2. Set **EUDIPLO Instance** to `http://localhost:3000`.
3. Read `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` from the generated `.eudiplo.env` and enter them in **Client ID** and **Client Secret**.
4. Click **Login**.

**Expected result:** you are signed in as the root administrator and can manage tenants. The next chapter creates a tenant for the recipe.

## If something goes wrong

| Symptom                                | Check                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers do not start                | Start Docker or Podman; check for another process already using ports 3000 or 4200. Run `eudiplo status`.                                                  |
| Local health works, phone health fails | Check the tunnel target is port 3000, the tunnel is still running, and HTTPS works without an interstitial page.                                           |
| Login fails                            | Use the generated values from `.eudiplo.env`, not `root` / `root` from demo mode.                                                                          |
| Wallet URLs contain `localhost`        | Check `PUBLIC_URL` in `.eudiplo.env`. After correcting it, recreate the backend container with the generated Compose configuration and create a new offer. |

For example, after editing the environment file:

```bash
docker compose --env-file .eudiplo.env -f eudiplo.compose.yaml up -d --force-recreate
```

To stop this deployment later, run `eudiplo down` from the project directory. Keep it running for the remaining chapters.

**Next: [Issue Your First Credential](first-credential.md).**

## Web Client

EUDIPLO provides a user-friendly web interface for credential management—no API expertise required. Simply enter your instance URL and credentials to get started. There's no need to deploy a separate client for each instance.

There is no need to use the client to interact with EUDIPLO, but it offers a more intuitive way to manage the configurations.

### Getting Started

#### Accessing the Web Client

After completing the [Quick Start setup](foundation.md):

1. **Open your browser** and go to: [http://localhost:4200](http://localhost:4200)
2. **Login** using the default credentials:
   - **Username:** `root`
   - **Password:** `root`

#### Hosting from a Subpath

If the client is served from a path such as `https://example.com/client/`, set `CLIENT_BASE_HREF=/client/` when starting the client. This updates the HTML base href and keeps routing and asset loading correct for the subpath.

If you are using a reverse proxy, it must also forward `/client/` to the client container. See [Serving the Client from a Subpath](../operate/tls.md#serving-the-client-from-a-subpath) for a full example.

:::warning[Important]
Change the default credentials before using EUDIPLO in production. See [Authentication](../operate/tenants-and-access.md#api-authentication) for details.
:::

### Dashboard Overview

The dashboard offers:

- **Quick Actions:** One-click access to common tasks
- **Statistics:** Usage metrics and activity summaries _(coming soon)_

### Core Features

#### 🎫 Credential Issuance Management

- Create, edit, import, or delete credential and issuance configurations
- Import keys and certificates, and link them to configurations

#### ✅ Credential Verification

- Manage verification flows
- Create, edit, import, or delete verification configurations

#### 📋 Session Management

- View and manage active issuance and verification sessions
- Inspect session details, including parameters

#### 🧑‍💼 Client Management

- Create new tenants with client ID and secret (Keycloak only)
- Not supported for other identity providers or when using EUDIPLO as IAM yet

### Configuration Editing & Validation

The web client is designed for intuitive and robust configuration management:

- **Data Model & Validation:** The EUDIPLO service uses decorators on data transfer objects (DTOs) and entities to describe variables and their values, enabling server-side validation.
- **OpenAPI Specification:** An OpenAPI spec is generated from these DTOs and entities, providing a standardized interface for backend interaction.
- **SDK Integration:** The web client uses an SDK generated from the OpenAPI spec for seamless and type-safe communication with the backend.
- **Editing Experience:**
    - Simple variables (strings, numbers, booleans) are edited via text inputs, select options, or checkboxes.
    - Complex data structures are managed using an integrated JSON editor (Monaco Editor), which leverages JSON schemas for each variable.

- **Client-Side Validation & Guidance:** The JSON editor uses the provided JSON schemas to offer inline descriptions, auto-completion, and validation directly in the browser.
- **Direct JSON Access:** Each configuration can be viewed and edited as raw JSON for advanced use cases.
