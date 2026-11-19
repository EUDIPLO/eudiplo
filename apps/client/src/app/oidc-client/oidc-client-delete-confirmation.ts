/** Question to confirm before an OIDC client is deleted, on its list and on its page. */
export function oidcClientDeleteConfirmation(name: string): string {
  return `Delete OIDC client "${name}"? Applications using it can no longer sign users in. This cannot be undone.`;
}
