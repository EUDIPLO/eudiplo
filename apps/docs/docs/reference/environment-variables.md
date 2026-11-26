---
title: Environment Variables
---

# Environment Variables

All environment variables of the EUDIPLO backend, generated from its validation
schema. The backend refuses to start when a value is invalid or a required
variable is missing. KMS providers are configured in JSON files instead
([KMS config](kms-config.md)); the variables of the `eudiplo` CLI are listed in the
[CLI guide](../operate/cli.md#environment-variables).

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

## Federation

See [OpenID Federation](../trust/federation.md).

<ConfigTable group="federation" />

## General

<ConfigTable group="general" />

## Issuer

<ConfigTable group="issuer" />

## Logging

<ConfigTable group="log" />

## Observability

<ConfigTable group="observability" />

## Registrar

Connection to the German EUDI Hub ([EUDI Hub](../trust/eudi-hub.md)).

<ConfigTable group="registrar" />

## Secret references

See [Secret references](../operate/secret-references.md).

<ConfigTable group="secrets" />

## Session

<ConfigTable group="session" />

## Skip Flags

Every switch that turns off a check of the normal flow is named `SKIP_<CHECK>`
and defaults to `false`. On startup, EUDIPLO warns that protection mechanisms
are disabled and lists the active skip flags with the protection each one turns
off. Use them only for development and interoperability tests.

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

## Container image

The entrypoint of the `ghcr.io/eudiplo/eudiplo` image reads this variable
before the backend starts; the backend itself ignores it.

| Variable      | Default | Description                                                                                                                                                 |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EUDIPLO_RUN_AS_ROOT` | `false` | `true` keeps the backend running as root instead of the owner of `FOLDER` or `node` (`1000:1000`). See [Non-root user](../operate/docker-compose.md#non-root-user). |
