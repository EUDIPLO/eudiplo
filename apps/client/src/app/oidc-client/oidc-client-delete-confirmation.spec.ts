import { describe, expect, it } from 'vitest';

import { oidcClientDeleteConfirmation } from './oidc-client-delete-confirmation';

describe('oidcClientDeleteConfirmation', () => {
  it('names the client and says that applications can no longer sign users in', () => {
    expect(oidcClientDeleteConfirmation('Portal')).toBe(
      'Delete OIDC client "Portal"? Applications using it can no longer sign users in. This cannot be undone.'
    );
  });
});
