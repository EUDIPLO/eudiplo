import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmTenantDelete, tenantDeleteQuestion } from './tenant-delete-confirmation';

describe('tenantDeleteQuestion', () => {
  it('names the tenant by name and ID, says what is deleted and asks for the ID', () => {
    const question = tenantDeleteQuestion({ id: 'acme', name: 'ACME Corp' });

    expect(question).toMatch(/^Delete tenant "ACME Corp" \(acme\) and all its data\?/);
    expect(question).toContain('key chains, configurations, API clients, sessions');
    expect(question).toContain('This cannot be undone.');
    expect(question).toMatch(/Type the tenant ID "acme" to confirm\.$/);
  });

  it('names a tenant whose name is its ID once', () => {
    expect(tenantDeleteQuestion({ id: 'acme', name: 'acme' })).toMatch(
      /^Delete tenant "acme" and all its data\?/
    );
  });
});

describe('confirmTenantDelete', () => {
  const tenant = { id: 'acme', name: 'ACME Corp' };
  const snackBar = () => ({ open: vi.fn() });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('confirms when the ID is typed, also with surrounding spaces', () => {
    vi.stubGlobal('prompt', () => ' acme ');

    expect(confirmTenantDelete(snackBar() as never, tenant)).toBe(true);
  });

  it('does not confirm a cancel, and says nothing', () => {
    vi.stubGlobal('prompt', () => null);
    const bar = snackBar();

    expect(confirmTenantDelete(bar as never, tenant)).toBe(false);
    expect(bar.open).not.toHaveBeenCalled();
  });

  it('does not confirm the name or another ID, and says so', () => {
    vi.stubGlobal('prompt', () => 'ACME Corp');
    const bar = snackBar();

    expect(confirmTenantDelete(bar as never, tenant)).toBe(false);
    expect(bar.open.mock.lastCall?.[0]).toBe(
      'The ID you typed is not "acme". The tenant was not deleted.'
    );
  });
});
