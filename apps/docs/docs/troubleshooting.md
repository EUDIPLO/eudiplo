---
title: Troubleshooting
---

## "Login failed" error

- Remove trailing `/` from the EUDIPLO instance URL
- Verify `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` match your configuration
- Check that the backend is running at the specified URL

## Wallet connection issues

- Ensure your wallet is compatible (see [Wallet Compatibility](reference/wallet-compatibility.md))
- For mobile wallets, EUDIPLO must be accessible via a public HTTPS URL
- Check DPoP settings match wallet capabilities

## Credential issuance fails

- Verify credential configuration includes all required fields
- Check that signing keys exist for the tenant
- Review issuance configuration for correct authorization server settings

For more troubleshooting guidance, see the specific sections in [Issuance](issuance/index.md) and [Presentation](presentation/index.md).
