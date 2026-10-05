![Logo](./apps/docs/static/img/eudiplo.png)

[![Build Status](https://github.com/EUDIPLO/eudiplo/actions/workflows/ci-and-release.yml/badge.svg)](https://github.com/EUDIPLO/eudiplo/actions)
![License](https://img.shields.io/github/license/EUDIPLO/eudiplo)
[![Website](https://img.shields.io/badge/website-eudiplo-blue)](https://eudiplo.dev)
[![Docs](https://img.shields.io/badge/docs-eudiplo-blue)](https://docs.eudiplo.dev)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=EUDIPLO_eudiplo&metric=security_rating)](https://sonarcloud.io/project/overview?id=EUDIPLO_eudiplo)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=EUDIPLO_eudiplo&metric=alert_status)](https://sonarcloud.io/project/overview?id=EUDIPLO_eudiplo)
[![Join our Discord](https://img.shields.io/discord/1022962884864643214?label=Join%20our%20Discord&logo=discord&color=7289DA&labelColor=2C2F33)](https://discord.gg/58ys8XfXDu)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/EUDIPLO/eudiplo/badge)](https://scorecard.dev/viewer/?uri=github.com/EUDIPLO/eudiplo)

# Your Diplomatic Layer for EUDI Wallet Integration

EUDIPLO is an open-source middleware that bridges your backend and EUDI Wallets
using a unified API and standardized protocols.

EUDIPLO is an [LF Decentralized Trust](https://www.lfdecentralizedtrust.org/)
project. It was previously hosted by the OpenWallet Foundation.

---

## 🧭 Overview

Organizations joining the EUDI Wallet ecosystem face a tough choice: patch
together protocol libraries that may not exist for their stack, or rely on
proprietary solutions that risk vendor lock-in.

**EUDIPLO** solves this by providing a lightweight, source-available, protocol
abstraction layer. It communicates over HTTP and integrates easily with your
existing backend stack—so you can focus on your business logic, not
cryptographic plumbing.

It supports all core flows of electronic attribute attestations—**issuing**,
**requesting**, and even **requesting during issuance**—and is already
compatible with multiple
[wallets](./apps/docs/docs/reference/wallet-compatibility.md).

While still in early development, EUDIPLO is built for production: secure key
management, scalable database support, and clean API boundaries.

![EUDIPLO architecture overview](./apps/docs/static/img/overview.svg)

> Documentation policy: the docs on `main` represent the current development state and preview builds. Stable public documentation is preserved as major-version snapshots for released versions.

## 🧩 Features

- ✅ Supports **OID4VCI**, **OID4VP**, **SD-JWT VC**, **mDOC (ISO 18013-5)**, and **OAuth Token Status
  List**
- ✅ **OIDF conformance tested** for OID4VCI and OID4VP protocols
- ✅ JSON-based credential configuration
- ✅ Client credentials authentication for easy service integration
- ✅ Runs via Docker with `.env` config
- ✅ HTTP-based integration with any backend
- ✅ Secure key management & pluggable storage
- ✅ Privacy-friendly: no external calls, no long-term storage

---

## 📺 Watch the Webinar

Curious about EUDIPLO? Check out our recorded webinar (September 17, 2025) for a deep dive into features, architecture, and live Q&A:

[![EUDIPLO Webinar](https://img.youtube.com/vi/GQlvHK-EFlU/0.jpg)](https://www.youtube.com/watch?v=GQlvHK-EFlU)

[Watch on YouTube](https://www.youtube.com/watch?v=GQlvHK-EFlU)

## 🤝 Community Call

Join our bi-weekly community call every Thursday:

[Participate via Zoom](https://zoom-lfx.platform.linuxfoundation.org/meeting/94494306854?password=0d272140-5b2b-4bd4-a8fe-0b70efe1aa86)

## 🚀 Quick Start

Requirements:

- Docker with Docker Compose
- Linux, macOS, or Windows

### Linux and macOS: standalone CLI

```bash
curl -fsSL https://eudiplo.dev/install.sh | bash
eudiplo demo
```

No local Node.js installation is required.

### Already using Node.js 22.12+?

```bash
npx @eudiplo/cli demo
```

### Windows

Use `npx @eudiplo/cli demo` with Node.js 22.12+, or download the Windows x64
standalone executable from GitHub Releases.

Both commands run the same **EUDIPLO CLI**:

1. **Standalone CLI**: native executable, no Node.js required.
2. **npm package**: `@eudiplo/cli`, requires Node.js 22.12+.

`eudiplo demo` creates a **demo deployment** for local evaluation:

- Creates editable demo configuration (`.eudiplo.demo.env` and `config/demo/`).
- Uses the minimal topology: SQLite, local file storage, and database-backed keys.
- Starts the backend and web client using Docker Compose.
- Exposes the API at `http://localhost:3000`.
- Exposes the web client at `http://localhost:4200`.
- Uses demo credentials that must not be used in production.

For a configurable local deployment, run `eudiplo init ./eudiplo-local`. In an
interactive terminal it asks for a preset or individual database, storage,
key-management, public URL, and authentication choices. The same choices are
available as flags, for example
`eudiplo init ./eudiplo-local --preset standard --start`.

Local tenant configuration can be scaffolded and managed with:

```bash
eudiplo config tenant list
eudiplo config tenant create acme --name "Acme GmbH"
eudiplo config tenant remove acme --force
```

See the detailed guides:

- [Quick Start](https://docs.eudiplo.dev/cookbooks/foundation)
- [EUDIPLO CLI](https://docs.eudiplo.dev/operate/cli)
- [API Reference](https://docs.eudiplo.dev/reference/api)

### Other deployment options

- Docker Compose deployment: [Deployment Guide](https://docs.eudiplo.dev/operate/docker-compose)
- Individual container images: [Deployment Options](https://docs.eudiplo.dev/operate)
- Local development workflow: [Development Guide](https://docs.eudiplo.dev/contributing/development-setup)

### Get Started with the API

```bash
# Get a token and start using the API
# Replace with your configured AUTH_CLIENT_ID and AUTH_CLIENT_SECRET
curl -X POST http://localhost:3000/api/oauth2/token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "your-client-id",
    "client_secret": "your-client-secret"
  }'
```

For production authentication setup, see [Authentication](https://docs.eudiplo.dev/operate/tenants-and-access).

---

## 📚 Documentation

Use the current documentation:

- 🚀 **Documentation**: [https://docs.eudiplo.dev/](https://docs.eudiplo.dev/)
- **Legacy documentation**: [https://eudiplo.github.io/eudiplo/docs/latest/](https://eudiplo.github.io/eudiplo/docs/latest/)

The current documentation reflects the active release. For older releases,
use the [legacy documentation archive](https://eudiplo.github.io/eudiplo/docs/latest/).

**Key sections:**

- [Architecture](https://docs.eudiplo.dev/concepts/)
- [Supported Protocols](https://docs.eudiplo.dev/reference/protocols)
- [API Reference](https://docs.eudiplo.dev/reference/api)

---

## 🤝 Contributing

We welcome PRs from wallet developers, institutions, and contributors interested
in advancing the EUDI Wallet ecosystem.

See [CONTRIBUTING.md](CONTRIBUTING.MD) for guidelines.

💬 **Have questions?** Join our
[Discord community](https://discord.gg/58ys8XfXDu) to ask questions, get help,
and connect with other developers.

---

## 📝 License

Licensed under the [Apache 2.0 License](LICENSE)

## Governance

EUDIPLO is a project of [LF Decentralized Trust](https://www.lfdecentralizedtrust.org/)
and follows the
[LF Decentralized Trust Code of Conduct](https://lf-decentralized-trust.github.io/governance/governing-documents/code-of-conduct/).

The Project Charter for EUDIPLO can be found [here](<https://github.com/openwallet-foundation/technical-project-charters/blob/main/EUDIPLO%20Technical%20Charter%20(FINAL%2008.11.25).pdf>).
