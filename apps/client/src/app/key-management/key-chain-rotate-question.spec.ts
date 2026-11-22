import type { KeyChainResponseDto } from '@eudiplo/sdk-core';
import { describe, expect, it } from 'vitest';

import { keyChainRotateQuestion } from './key-chain-rotate-question';

const keyChain = (overrides: Partial<KeyChainResponseDto> = {}) =>
  ({
    id: 'k',
    type: 'standalone',
    usageType: 'attestation',
    ...overrides,
  }) as KeyChainResponseDto;

describe('keyChainRotateQuestion', () => {
  it('names the key chain by description and ID and says it cannot be undone', () => {
    const question = keyChainRotateQuestion(keyChain({ description: 'Signing' }));

    expect(question).toMatch(/^Rotate key chain "Signing" \(k\) now\?/);
    expect(question).toContain('The current key becomes the previous key');
    expect(question).toMatch(/This cannot be undone\.$/);
  });

  it('names a key chain without description by its ID alone', () => {
    expect(keyChainRotateQuestion(keyChain())).toMatch(/^Rotate key chain "k" now\?/);
  });

  it('says that a CA-issued certificate of a standalone key is replaced by a self-signed one', () => {
    const question = keyChainRotateQuestion(
      keyChain({
        activeCertificate: { pem: '', subject: 'CN=key', issuer: 'CN=EUDI Hub CA' },
      })
    );

    expect(question).toContain(
      'The active certificate issued by "CN=EUDI Hub CA" is replaced by a self-signed certificate'
    );
  });

  it('says that a self-signed standalone key gets a new self-signed certificate', () => {
    const question = keyChainRotateQuestion(
      keyChain({ activeCertificate: { pem: '', subject: 'CN=key', issuer: 'CN=key' } })
    );

    expect(question).toContain('The new key gets a new self-signed certificate.');
    expect(question).not.toContain('issued by');
  });

  it('says that a key chain with a root CA keeps its root CA', () => {
    const question = keyChainRotateQuestion(
      keyChain({
        type: 'internalChain',
        rootCertificate: { pem: '', subject: 'CN=root', issuer: 'CN=root' },
        activeCertificate: { pem: '', subject: 'CN=key', issuer: 'CN=root' },
      })
    );

    expect(question).toContain("certificate from the key chain's root CA, which stays the same");
    expect(question).not.toContain('self-signed');
  });

  it('says nothing about the unused certificate of keys published as a JWK', () => {
    for (const usageType of ['federation', 'authorizationServer'] as const) {
      const question = keyChainRotateQuestion(
        keyChain({
          usageType,
          activeCertificate: { pem: '', subject: 'CN=key', issuer: 'CN=key' },
        })
      );

      expect(question).not.toContain('certificate');
    }
  });
});
