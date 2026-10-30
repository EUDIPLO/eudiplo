import { describe, expect, it } from 'vitest';

import { keyChainDeleteConsequence, keyChainDeleteQuestion } from './key-chain-delete-question';

describe('keyChainDeleteQuestion', () => {
  it('names the key chain by description and ID', () => {
    expect(keyChainDeleteQuestion('k', 'Signing')).toMatch(/^Delete key chain "Signing" \(k\)\?/);
  });

  it('names a key chain without description by its ID alone', () => {
    const question = keyChainDeleteQuestion('k');

    expect(question).toMatch(/^Delete key chain "k"\? If a configuration names it/);
    expect(question).not.toContain('(');
    expect(question).toContain('If a configuration names it, the delete is refused');
    expect(question).toContain(
      'Configurations that name no key chain switch to another key chain of this usage type'
    );
  });
});

describe('keyChainDeleteConsequence', () => {
  it('warns that deleting an access token key ends the tokens it issued', () => {
    const consequence = keyChainDeleteConsequence('accessToken');

    expect(consequence).toContain('tokens it issued are refused');
    expect(consequence).toContain('creates a new one with ID access-token');
  });

  it('warns about the federation entity and says nothing for other usage types', () => {
    expect(keyChainDeleteConsequence('federation')).toContain('no longer trusted');
    expect(keyChainDeleteConsequence('attestation')).toBe('');
  });
});
