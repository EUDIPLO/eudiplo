import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyManagementProvidersComponent } from './key-management-providers.component';

describe('KeyManagementProvidersComponent tenant KMS configuration', () => {
  let keyChainService: Record<string, ReturnType<typeof vi.fn>>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let roles: string[];

  function create(): KeyManagementProvidersComponent {
    return new KeyManagementProvidersComponent(
      keyChainService as never,
      snackBar as never,
      { open: vi.fn() } as never,
      { hasRole: (role: string[]) => role.some((r) => roles.includes(r)) } as never
    );
  }

  beforeEach(() => {
    keyChainService = {
      getProviders: vi.fn().mockResolvedValue({ default: 'db', providers: [] }),
      getProvidersHealth: vi.fn().mockResolvedValue([]),
      getTenantKmsConfig: vi.fn().mockResolvedValue({
        tenantConfig: null,
        effectiveConfig: { providers: [] },
      }),
      updateTenantKmsConfig: vi.fn(),
      deleteTenantKmsConfig: vi.fn(),
    };
    snackBar = { open: vi.fn() };
    roles = [];
  });

  it('lists providers without loading the tenant configuration for key managers', async () => {
    roles = ['issuance:manage'];
    const component = create();

    await component.refresh();

    expect(component.canManageTenantConfig).toBe(false);
    expect(keyChainService['getProviders']).toHaveBeenCalled();
    expect(keyChainService['getTenantKmsConfig']).not.toHaveBeenCalled();
    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it.each(['tenant:admin', 'tenants:manage'])(
    'loads the tenant configuration with %s',
    async (role) => {
      roles = [role];
      const component = create();

      await component.refresh();

      expect(component.canManageTenantConfig).toBe(true);
      expect(keyChainService['getTenantKmsConfig']).toHaveBeenCalled();
    }
  );

  it('explains a rejected save', async () => {
    roles = ['tenant:admin'];
    keyChainService['updateTenantKmsConfig'].mockRejectedValue({ statusCode: 403 });

    await create().saveTenantConfig({ providers: [] } as never);

    expect(snackBar.open.mock.lastCall?.[0]).toContain('tenant:admin');
  });

  it('edits only the tenant providers, never the global ones', async () => {
    roles = ['tenant:admin'];
    keyChainService['getTenantKmsConfig'].mockResolvedValue({
      tenantConfig: null,
      effectiveConfig: {
        providers: [{ id: 'global-vault', type: 'vault', vaultToken: '<redacted>' }],
      },
    });
    const component = create();

    await component.refresh();

    expect(component.tenantConfig).toEqual({ providers: [] });
  });
});
