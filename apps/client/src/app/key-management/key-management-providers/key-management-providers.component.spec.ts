import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { expectAvailable, expectUnavailable } from '../../common/unavailable-action.testing';
import { JwtService } from '../../services/jwt.service';
import { KeyChainService } from '../key-chain.service';
import { KeyManagementProvidersComponent } from './key-management-providers.component';

describe('KeyManagementProvidersComponent tenant KMS configuration', () => {
  let keyChainService: Record<string, ReturnType<typeof vi.fn>>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let roles: string[];

  let dialog: { open: ReturnType<typeof vi.fn> };

  function create(): KeyManagementProvidersComponent {
    return new KeyManagementProvidersComponent(
      keyChainService as never,
      snackBar as never,
      dialog as never,
      { hasRole: (role: string[]) => role.some((r) => roles.includes(r)) } as never
    );
  }

  /** The save the editor runs on Apply Changes before it closes. */
  function editorSave(): (json: unknown) => Promise<boolean> {
    return dialog.open.mock.lastCall?.[1]?.data.save;
  }

  const tenantProviders = { providers: [{ id: 'vault', type: 'vault' }] };

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
    dialog = { open: vi.fn() };
    roles = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    expect(await create().saveTenantConfig({ providers: [] } as never)).toBe(false);

    expect(snackBar.open.mock.lastCall?.[0]).toContain('tenant:admin');
  });

  it('saves from the editor and keeps the edit there when the save fails', async () => {
    roles = ['tenant:admin'];
    keyChainService['getTenantKmsConfig'].mockResolvedValue({
      tenantConfig: tenantProviders,
      effectiveConfig: tenantProviders,
    });
    keyChainService['updateTenantKmsConfig'].mockRejectedValue({
      statusCode: 400,
      message: 'providers.0.type must be one of db, vault',
    });
    const component = create();
    await component.refresh();

    await component.openTenantConfigEditor();
    const edited = { providers: [{ id: 'vault', type: 'nope' }] };

    // false keeps the editor open with the edited JSON.
    expect(await editorSave()(edited)).toBe(false);
    expect(keyChainService['updateTenantKmsConfig']).toHaveBeenCalledWith(edited);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to save tenant KMS configuration: providers.0.type must be one of db, vault'
    );
    expect(component.tenantConfig).toEqual(tenantProviders);
    expect(component.isSavingConfig).toBe(false);
  });

  it('closes the editor once the configuration is saved and reloads the providers', async () => {
    roles = ['tenant:admin'];
    keyChainService['updateTenantKmsConfig'].mockResolvedValue({
      tenantConfig: tenantProviders,
      effectiveConfig: tenantProviders,
    });
    const component = create();
    await component.refresh();
    await component.openTenantConfigEditor();
    keyChainService['getProviders'].mockClear();

    expect(await editorSave()(tenantProviders)).toBe(true);

    expect(component.hasTenantConfig).toBe(true);
    expect(component.tenantConfig).toEqual(tenantProviders);
    expect(snackBar.open.mock.lastCall?.[0]).toBe('Tenant KMS configuration saved');
    expect(keyChainService['getProviders']).toHaveBeenCalledOnce();
  });

  it('asks before resetting to the global configuration and resets only when confirmed', async () => {
    roles = ['tenant:admin'];
    keyChainService['getTenantKmsConfig'].mockResolvedValue({
      tenantConfig: tenantProviders,
      effectiveConfig: tenantProviders,
    });
    keyChainService['deleteTenantKmsConfig'].mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const component = create();
    await component.refresh();

    await component.resetTenantConfig();

    expect(confirm.mock.lastCall?.[0]).toContain(
      "Delete the tenant KMS configuration and use the global configuration? The tenant's providers and their stored credentials are removed."
    );
    expect(confirm.mock.lastCall?.[0]).toContain('This cannot be undone.');
    expect(keyChainService['deleteTenantKmsConfig']).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await component.resetTenantConfig();

    expect(keyChainService['deleteTenantKmsConfig']).toHaveBeenCalledOnce();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Tenant KMS configuration reset to global defaults'
    );
  });

  it("shows the backend's reason when saving or resetting fails for another reason", async () => {
    roles = ['tenant:admin'];
    const conflict = { statusCode: 409, message: 'The KMS configuration is file-managed.' };
    keyChainService['updateTenantKmsConfig'].mockRejectedValue(conflict);
    keyChainService['deleteTenantKmsConfig'].mockRejectedValue(conflict);
    keyChainService['getTenantKmsConfig'].mockResolvedValue({
      tenantConfig: tenantProviders,
      effectiveConfig: tenantProviders,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const component = create();
    await component.refresh();

    await component.saveTenantConfig({ providers: [] } as never);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to save tenant KMS configuration: The KMS configuration is file-managed.'
    );

    await component.resetTenantConfig();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to reset tenant KMS configuration: The KMS configuration is file-managed.'
    );
  });

  it('names the request that failed when the page loads', async () => {
    roles = ['tenant:admin'];
    keyChainService['getTenantKmsConfig'].mockRejectedValue({
      statusCode: 500,
      message: 'offline',
    });
    const component = create();

    await component.refresh();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to load the tenant KMS configuration: offline'
    );

    keyChainService['getProviders'].mockRejectedValue({ statusCode: 500, message: 'offline' });
    await component.refresh();
    expect(snackBar.open.mock.lastCall?.[0]).toBe('Failed to load KMS providers: offline');
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

  function render() {
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
    // Stands in for Apply Changes: the editor saves before it closes.
    const openDialog = vi
      .spyOn(fixture.debugElement.injector.get(MatDialog), 'open')
      .mockImplementation((_component, config) => {
        void (config?.data as { save: (json: unknown) => Promise<boolean> }).save({
          providers: [],
        });
        return {} as never;
      });
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Show tenant config JSON"]'
    )!;
    return { fixture, openDialog, button };
  }

  /** Clicks are held back until the ownership lookup of the managed resource has answered. */
  async function ownershipAnswered(
    fixture: ReturnType<typeof render>['fixture'],
    button: HTMLButtonElement
  ): Promise<void> {
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(button.getAttribute('aria-busy')).toBeNull();
    });
  }

  it('keeps the tenant config button focusable while the configuration saves', async () => {
    roles = ['tenant:admin'];
    keyChainService['updateTenantKmsConfig'].mockReturnValue(new Promise(() => undefined));
    const { fixture, openDialog, button } = render();
    await ownershipAnswered(fixture, button);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.tenantConfigLoaded).toBe(true);
    });
    expectAvailable(fixture, button, 'Show tenant config JSON');

    button.click();
    fixture.detectChanges();
    button.click();
    fixture.detectChanges();

    expect(openDialog).toHaveBeenCalledOnce();
    expect(keyChainService['updateTenantKmsConfig']).toHaveBeenCalledOnce();
    expectUnavailable(fixture, button, 'Wait until the tenant KMS configuration has been saved');
  });

  it('opens no editor while the tenant configuration loads', async () => {
    roles = ['tenant:admin'];
    keyChainService['getTenantKmsConfig'].mockReturnValue(new Promise(() => undefined));
    const { fixture, openDialog, button } = render();
    await ownershipAnswered(fixture, button);

    expectUnavailable(fixture, button, 'Wait until the tenant KMS configuration has loaded');
    button.click();
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('opens no editor, and so saves no empty provider list, after a failed load', async () => {
    roles = ['tenant:admin'];
    keyChainService['getTenantKmsConfig'].mockRejectedValue(new Error('offline'));
    const { fixture, openDialog, button } = render();
    await ownershipAnswered(fixture, button);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.isLoading).toBe(false);
    });
    fixture.detectChanges();

    expectUnavailable(
      fixture,
      button,
      'The tenant KMS configuration could not be loaded. Refresh the providers to try again'
    );
    // Whether tenant providers are set is unknown, so the card does not claim either.
    expect(fixture.nativeElement.querySelector('.tenant-config .badge')).toBeNull();
    button.click();
    expect(openDialog).not.toHaveBeenCalled();
    expect(keyChainService['updateTenantKmsConfig']).not.toHaveBeenCalled();

    keyChainService['getTenantKmsConfig'].mockResolvedValue({
      tenantConfig: { providers: [{ id: 'vault', type: 'vault' }] },
      effectiveConfig: { providers: [] },
    });
    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    expectAvailable(fixture, button, 'Show tenant config JSON');
    expect(fixture.nativeElement.querySelector('.tenant-config .badge')?.textContent).toContain(
      'Tenant providers set'
    );
    button.click();
    expect(openDialog).toHaveBeenCalledOnce();
    expect(openDialog.mock.lastCall?.[1]?.data).toMatchObject({
      jsonData: { providers: [{ id: 'vault', type: 'vault' }] },
    });
  });

  it('names the provider list when that fails before the tenant configuration loads', async () => {
    roles = ['tenant:admin'];
    keyChainService['getProviders'].mockRejectedValue(new Error('offline'));
    const { fixture, openDialog, button } = render();
    await ownershipAnswered(fixture, button);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.isLoading).toBe(false);
    });
    fixture.detectChanges();

    expect(keyChainService['getTenantKmsConfig']).not.toHaveBeenCalled();
    expectUnavailable(
      fixture,
      button,
      'The KMS providers could not be loaded. Refresh the providers to try again'
    );
    button.click();
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('offers to use the global configuration only while tenant providers are set', async () => {
    roles = ['tenant:admin'];
    const { fixture, button } = render();
    await ownershipAnswered(fixture, button);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.tenantConfigLoaded).toBe(true);
    });
    const page = fixture.nativeElement as HTMLElement;
    const reset = () =>
      [...page.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Use global configuration')
      );
    expect(reset()).toBeUndefined();

    keyChainService['getTenantKmsConfig'].mockResolvedValue({
      tenantConfig: tenantProviders,
      effectiveConfig: tenantProviders,
    });
    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    expect(reset()).toBeDefined();
  });

  it('locks the editor again when a refresh fails after a successful load', async () => {
    roles = ['tenant:admin'];
    const { fixture, openDialog, button } = render();
    await ownershipAnswered(fixture, button);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.tenantConfigLoaded).toBe(true);
    });
    expectAvailable(fixture, button, 'Show tenant config JSON');

    keyChainService['getTenantKmsConfig'].mockRejectedValue(new Error('offline'));
    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    expectUnavailable(
      fixture,
      button,
      'The tenant KMS configuration could not be loaded. Refresh the providers to try again'
    );
    button.click();
    expect(openDialog).not.toHaveBeenCalled();
  });
});
