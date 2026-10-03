---
title: Environment Variables
---

# Environment Variables

EUDIPLO is configured primarily through environment variables. This page documents all available configuration options organized by functional area.

## Quick Reference

The complete environment variable reference is organized into the following sections:

- [Authentication](#authentication) — OAuth client credentials and token validation
- [Configuration](#configuration) — File-based tenant configuration import
- [Cryptography](#cryptography) — Key generation and cryptographic defaults
- [Database](#database) — Database connection and type selection
- [Encryption](#encryption) — At-rest encryption for database-backed keys
- [General](#general) — Public URL, CORS, and operational settings
- [Issuer](#issuer) — Credential issuance flow defaults
- [Logging](#logging) — Log level and structured logging
- [Observability](#observability) — OpenTelemetry tracing configuration
- [Session](#session) — Session cleanup and retention policies
- [Skip Flags](#skip-flags) — Development-only switches that turn off checks
- [Status](#status) — Status list configuration
- [Storage](#storage) — File storage provider (local/S3)
- [TLS](#tls) — Built-in HTTPS termination
- [Verifier](#verifier) — Presentation verification defaults
- [Webhook](#webhook) — Outbound webhook security policies

import ConfigTable from "@site/src/components/ConfigTable";

## Authentication

<ConfigTable group="auth" />

## Configuration

<ConfigTable group="config" />

## Cryptography

<ConfigTable group="crypto" />

## Database

<ConfigTable group="database" />

## Encryption

<ConfigTable group="encryption" />

## General

<ConfigTable group="general" />

## Issuer

<ConfigTable group="issuer" />

## Logging

<ConfigTable group="log" />

## Observability

<ConfigTable group="observability" />

## Session

<ConfigTable group="session" />

## Skip Flags

Every switch that turns off a check of the normal, secure flow is named `SKIP_<CHECK>` and defaults to `false`. Active skip flags are listed as warnings in the startup log. Use them only for development and interoperability testing, never in production.

<ConfigTable group="skip" />

## Status

<ConfigTable group="status" />

## Storage

<ConfigTable group="storage" />

## TLS

<ConfigTable group="tls" />

## Verifier

<ConfigTable group="verifier" />

## Webhook

<ConfigTable group="webhook" />

:::info
Key Management System (KMS) and Registrar provider settings are configured via JSON files (`kms.json`, `registrar.json`), not environment variables — see [Key Management System (KMS)](../operate/kms.md) and [Registrar](../trust/registrar.md).
:::
