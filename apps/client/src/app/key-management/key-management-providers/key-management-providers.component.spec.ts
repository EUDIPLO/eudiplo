import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { expectUnavailable, tooltipOf } from '../../common/unavailable-action.testing';
import { JwtService } from '../../services/jwt.service';
import { KeyChainService } from '../key-chain.service';
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

  it("keeps each provider's algorithms and default", async () => {
    keyChainService['getProviders'].mockResolvedValue({
      default: 'db',
      providers: [
        {
          name: 'db',
          type: 'db',
          capabilities: {
            canCreate: true,
            canImport: true,
            canDelete: true,
            supportedAlgs: ['ES256', 'ES384'],
            defaultAlg: 'ES384',
          },
        },
      ],
    });
    const component = create();

    await component.refresh();

    expect(component.rows[0]).toMatchObject({
      supportedAlgs: ['ES256', 'ES384'],
      defaultAlg: 'ES384',
    });
  });

  it('explains a rejected save', async () => {
    roles = ['tenant:admin'];
    keyChainService['updateTenantKmsConfig'].mockRejectedValue({ statusCode: 403 });

    await create().saveTenantConfig({ providers: [] } as never);

    expect(snackBar.open.mock.lastCall?.[0]).toContain('tenant:admin');
  });

  it("shows the backend's reason when saving or resetting fails for another reason", async () => {
    roles = ['tenant:admin'];
    const conflict = { statusCode: 409, message: 'The KMS configuration is file-managed.' };
    keyChainService['updateTenantKmsConfig'].mockRejectedValue(conflict);
    keyChainService['deleteTenantKmsConfig'].mockRejectedValue(conflict);
    const component = create();

    await component.saveTenantConfig({ providers: [] } as never);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to save tenant KMS configuration: The KMS configuration is file-managed.'
    );

    await component.resetTenantConfig();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to reset tenant KMS configuration: The KMS configuration is file-managed.'
    );
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

  it('keeps the tenant config button focusable while the configuration saves', async () => {
    roles = ['tenant:admin'];
    keyChainService['updateTenantKmsConfig'].mockReturnValue(new Promise(() => undefined));
    TestBed.configureTestingModule({
      imports: [KeyManagementProvidersComponent],
      providers: [
        provideRouter([]),
        { provide: KeyChainService, useValue: keyChainService },
        { provide: MatSnackBar, useValue: snackBar },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string[]) => role.some((r) => roles.includes(r)),
            canUseConfigPortability: () => false,
          },
        },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(KeyManagementProvidersComponent);
    // MatDialogModule in the component's imports provides its own MatDialog.
    const openDialog = vi
      .spyOn(fixture.debugElement.injector.get(MatDialog), 'open')
      .mockReturnValue({ afterClosed: () => of({ providers: [] }) } as never);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Show tenant config JSON"]'
    )!;
    // Clicks are held back until the ownership lookup of the managed resource has answered.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(button.getAttribute('aria-busy')).toBeNull();
    });
    expect(tooltipOf(fixture, button)).toBe('Show tenant config JSON');

    button.click();
    fixture.detectChanges();
    button.click();
    fixture.detectChanges();

    expect(openDialog).toHaveBeenCalledOnce();
    expect(keyChainService['updateTenantKmsConfig']).toHaveBeenCalledOnce();
    expectUnavailable(fixture, button, 'Saving the tenant KMS configuration…');
  });
});
