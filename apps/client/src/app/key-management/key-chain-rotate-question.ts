import type { KeyChainResponseDto } from '@eudiplo/sdk-core';

/**
 * Asks before rotating a key chain now. A rotation creates a new key, keeps the current one as
 * the previous key (dropping the one kept before) and cannot be undone. A key chain with a root
 * CA gets a certificate from that CA for the new key; any other key gets a self-signed one, so a
 * certificate a CA issued for a standalone key is replaced.
 */
export function keyChainRotateQuestion(keyChain: KeyChainResponseDto): string {
  const name = keyChain.description
    ? `"${keyChain.description}" (${keyChain.id})`
    : `"${keyChain.id}"`;
  return (
    `Rotate key chain ${name} now? EUDIPLO creates a new key and uses it from now on.` +
    ' The current key becomes the previous key; a previous key from an earlier rotation is dropped.' +
    certificateConsequence(keyChain) +
    ' This cannot be undone.'
  );
}

function certificateConsequence(keyChain: KeyChainResponseDto): string {
  // Federation and authorization server keys are published as a JWK; their certificate is unused.
  if (keyChain.usageType === 'federation' || keyChain.usageType === 'authorizationServer') {
    return '';
  }
  if (keyChain.type === 'internalChain' && keyChain.rootCertificate) {
    return " The new key gets a certificate from the key chain's root CA, which stays the same.";
  }
  const certificate = keyChain.activeCertificate;
  if (certificate && certificate.issuer !== certificate.subject) {
    const issuer = certificate.issuer ? `"${certificate.issuer}"` : 'a CA';
    return (
      ` The active certificate issued by ${issuer} is replaced by a self-signed certificate for` +
      ' the new key. To use a CA-issued certificate again, request one for the new key.'
    );
  }
  return ' The new key gets a new self-signed certificate.';
}
