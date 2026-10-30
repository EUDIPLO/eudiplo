/**
 * Asks before deleting a key chain. The backend refuses to delete a key chain that a
 * configuration names and says which ones, so the question says so instead of listing them
 * itself. Configurations that name no key chain use the default of the usage type, which the
 * backend does not count, so the question warns about them.
 */
export function keyChainDeleteQuestion(id: string, description?: string): string {
  const name = description ? `"${description}" (${id})` : `"${id}"`;
  return (
    `Delete key chain ${name}? If a configuration names it, the delete is refused and the` +
    ' configurations are named. Configurations that name no key chain switch to another key' +
    ' chain of this usage type, or fail if there is none. This cannot be undone.'
  );
}

/**
 * What deleting a key chain of the usage type breaks beyond the configurations that name it,
 * appended to {@link keyChainDeleteQuestion}; empty for the other usage types.
 */
export function keyChainDeleteConsequence(usageType: string): string {
  if (usageType === 'federation') {
    return ' If this key signs your OpenID Federation entity configuration, the entity is no longer trusted until your trust anchor lists the public key of a replacement federation key (and federation.entityKeyChainId, if set, names it).';
  }
  if (usageType === 'accessToken') {
    return ' If this key signs access tokens, tokens it issued are refused from now on, so issuances in progress fail. Without another access token key, EUDIPLO creates a new one with ID access-token on the next token request.';
  }
  return '';
}
