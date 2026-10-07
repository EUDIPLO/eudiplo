/**
 * Wallets and other verifiers reach EUDIPLO under the backend's public URL
 * (`PUBLIC_URL`, reported by `GET /api/frontend-config`). The instance URL the
 * admin signed in with can be an address only the admin can reach, such as
 * `http://localhost:3000` or the Compose-internal `http://eudiplo:3000`, so
 * wallet-facing URLs must not be built from it.
 *
 * The functions build the URLs the same way the backend does.
 */

/** URL a managed trust list is published under, as sent to wallets as `etsi_tl`. */
export function trustListUrl(publicUrl: string, tenantId: string, trustListId: string): string {
  return `${publicUrl}/issuers/${tenantId}/trust-list/${encodeURIComponent(trustListId)}`;
}

/** URL of the type metadata EUDIPLO hosts for a credential configuration; it becomes the `vct`. */
export function hostedVctUrl(
  publicUrl: string,
  tenantId: string,
  credentialConfigId: string
): string {
  return `${publicUrl}/issuers/${tenantId}/credentials-metadata/vct/${credentialConfigId}`;
}
