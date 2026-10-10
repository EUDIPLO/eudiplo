---
title: Cookbooks
sidebar_label: Overview
---

Each cookbook ends in a working result and has a checkpoint after every step. Start with **Issue and verify**: the other recipes build on the instance, tenant and wallet credential it creates.

## Recipes

| Recipe                                                       | Outcome                                                                                                | Prerequisites                                                                     | Starts from                        | Time       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| **Issue and verify**: [1. Install and connect](foundation.md), [2. Issue](first-credential.md), [3. Verify](first-presentation.md) | A membership credential in your phone's wallet, and a verified presentation of its claims from an issuer on your trust list | Docker or Podman, a wallet app on a phone, an HTTPS tunnel                         | Nothing                            | 70 min     |
| [Integrate into your backend](integrate-backend.md)          | Your backend creates offers and requests through the API and receives the results by webhook           | `curl`, `jq`, Node.js 22+                                                         | Issue and verify                   | 45 min     |
| [Issue after login](issue-after-login.md)                    | The wallet user signs in at Keycloak; the credential carries claims from your attribute provider       | A Keycloak realm reachable over HTTPS, Node.js 22+                                | Issue and verify                   | 60 min     |
| [Revocable credentials](revocable-credentials.md)            | You revoke or suspend one issued credential and the next presentation fails                            | `curl` and `jq`                                                                   | Issue and verify                   | 30 min     |
| [Accept only trusted issuers](trusted-issuers.md)            | A credential from an issuer outside your trust list is rejected, and verification works with a list published by someone else | `curl` and `jq`                                                                   | Issue and verify                   | 25 min     |
| [Production on one VM](production-vm.md)                     | EUDIPLO on a Linux server behind a TLS reverse proxy, with backups and a strict health check           | A VM with a DNS name, ports 80 and 443 open                                        | Nothing                            | 60 min     |

For a single task outside these recipes, go to the guides: [Issuance](../issuance/index.md), [Presentation](../presentation/index.md), [Trust](../trust/index.md) and [Operate](../operate/index.md). If a step fails, see [Troubleshooting](../troubleshooting.md).

## Shared values

All recipes use these values. Keep them unchanged so each recipe can reuse what the previous one created.

| Value                      | Used for                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| `membership-demo`          | Tenant ID                                                             |
| `membership`               | Credential configuration ID                                           |
| `urn:example:membership:1` | SD-JWT credential type (VCT), used for both issuance and verification |
| `name`, `member_id`        | Claim paths                                                           |
| `Max`, `M-001`             | Synthetic claim values                                                |
| `membership-issuers`       | Trust list ID of the issuers that `membership-check` accepts          |
| `membership-check`         | Presentation configuration ID                                         |
| `membership`               | Credential query ID inside the presentation request                   |
| `cookbook`                 | CLI instance name of the local deployment                             |

The credential configuration ID names what EUDIPLO issues. The VCT is the credential type the wallet must match. The presentation configuration ID names the reusable verification request.

## Choosing a wallet

Use a wallet that supports SD-JWT VC, the pre-authorized code flow and OpenID4VP. The [wallet compatibility record](../reference/wallet-compatibility.md) lists tested wallets and their limitations. Whether a wallet accepts self-signed certificates depends on the wallet and its test environment; [Wallet and registrar requirements](../trust/wallet-registrars.md) helps you choose.

:::note[Learning setup]
The recipes use one tenant as both issuer and verifier, test certificates and synthetic data. Before you handle real credentials, follow [Production on one VM](production-vm.md) and the [Operate](../operate/index.md) guides.
:::
