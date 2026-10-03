---
title: Environment Variables
---

# Environment Variables

All environment variables of the EUDIPLO backend, generated from its validation
schema. The backend refuses to start when a value is invalid or a required
variable is missing. KMS providers and the registrar are configured in JSON
files instead ([KMS config](kms-config.md), [Registrar](../trust/registrar.md));
the variables of the `eudiplo` CLI are listed in the
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

Every switch that turns off a check of the normal flow is named `SKIP_<CHECK>`
and defaults to `false`. The startup log lists active skip flags as warnings.
Use them only for development and interoperability tests.

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
