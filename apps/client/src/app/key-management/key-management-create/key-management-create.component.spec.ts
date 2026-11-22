import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import type { KeyChainResponseDto } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { KeyChainService } from '../key-chain.service';
import { KeyManagementCreateComponent } from './key-management-create.component';

describe('KeyManagementCreateComponent', () => {
  let keyChainService: { getById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  const keyChain = (overrides: Partial<KeyChainResponseDto> = {}) =>
    ({
      id: 'signing',
      description: 'PID signing',
      type: 'internalChain',
      usageType: 'attestation',
      rotationPolicy: { enabled: true, intervalDays: 30, certValidityDays: 365 },
      ...overrides,
    }) as KeyChainResponseDto;

  beforeEach(() => {
    keyChainService = {
      getById: vi.fn().mockResolvedValue(keyChain()),
      update: vi.fn().mockResolvedValue(undefined),
    };
    snackBar = { open: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function render() {
    await TestBed.configureTestingModule({
      imports: [KeyManagementCreateComponent],
      providers: [
        provideRouter([]),
        { provide: KeyChainService, useValue: keyChainService },
        { provide: ActivatedRoute, useValue: { snapshot: { params: { id: 'signing' } } } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    })
      // The component imports MatSnackBarModule, whose provider wins over a root provider.
      .overrideProvider(MatSnackBar, { useValue: snackBar })
      .compileComponents();
    const fixture = TestBed.createComponent(KeyManagementCreateComponent);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    return { fixture, component: fixture.componentInstance, page, navigate };
  }

  it.each([
    ['an internal chain', keyChain(), 'Internal Chain (Root CA + Signing Key)'],
    [
      'a self-signed standalone key',
      keyChain({
        type: 'standalone',
        activeCertificate: { subject: 'CN=Signing', issuer: 'CN=Signing' },
      } as Partial<KeyChainResponseDto>),
      'Standalone (Self-signed)',
    ],
    [
      'a standalone key with a CA-issued certificate',
      keyChain({
        type: 'standalone',
        activeCertificate: { subject: 'CN=Signing', issuer: 'CN=Example CA' },
      } as Partial<KeyChainResponseDto>),
      'Standalone (CA-issued certificate)',
    ],
    [
      'a standalone key without a certificate',
      keyChain({ type: 'standalone', usageType: 'federation' }),
      'Standalone',
    ],
  ])('names the type of %s', async (_, loaded, label) => {
    keyChainService.getById.mockResolvedValue(loaded);
    const { page } = await render();

    const type = [...page.querySelectorAll('.info-grid div')].find(
      (row) => row.querySelector('dt')?.textContent?.trim() === 'Type'
    );
    expect(type?.querySelector('dd')?.textContent?.trim()).toBe(label);
  });

  it('clears the stored description when the field is emptied', async () => {
    const { component } = await render();
    component.form.patchValue({ description: '' });

    await component.onSubmit();

    expect(keyChainService.update).toHaveBeenCalledWith(
      'signing',
      expect.objectContaining({ description: '' })
    );
  });

  it.each([0, 3651, 1.5, null])(
    'does not save a rotation interval of %s and says what to fix',
    async (days) => {
      const { fixture, component, page } = await render();
      component.form.patchValue({ rotationIntervalDays: days });

      await component.onSubmit();
      fixture.detectChanges();

      expect(keyChainService.update).not.toHaveBeenCalled();
      expect(snackBar.open.mock.lastCall?.[0]).toContain('Rotation Policy');
      expect(page.textContent).toContain('Enter a whole number of days from 1 to 3650');
    }
  );

  it('saves rotation turned off even when the hidden fields hold invalid values', async () => {
    const { component } = await render();
    component.form.patchValue({ rotationIntervalDays: 0, rotationEnabled: false });

    await component.onSubmit();

    expect(keyChainService.update).toHaveBeenCalledWith('signing', {
      description: 'PID signing',
      rotationPolicy: { enabled: false },
    });
  });

  it('sends one update when Save is selected twice', async () => {
    let finish!: () => void;
    keyChainService.update.mockReturnValue(new Promise<void>((done) => (finish = done)));
    const { fixture, component, page, navigate } = await render();
    const save = [...page.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Save Changes')
    )!;

    const first = component.onSubmit();
    fixture.detectChanges();
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await component.onSubmit();
    finish();
    await first;

    expect(keyChainService.update).toHaveBeenCalledOnce();
    expect(keyChainService.update).toHaveBeenCalledWith('signing', {
      description: 'PID signing',
      rotationPolicy: { enabled: true, intervalDays: 30, certValidityDays: 365 },
    });
    expect(navigate).toHaveBeenCalled();
    expect(component.saving).toBe(false);
  });

  it('lets a rotating standalone key chain turn rotation off and warns about its certificate', async () => {
    keyChainService.getById.mockResolvedValue(keyChain({ type: 'standalone' }));
    const { component, page } = await render();

    expect(page.textContent).toContain('Rotation Policy');
    expect(page.querySelector('.rotation-warning')?.textContent).toContain(
      'replaces a certificate issued by a CA'
    );

    component.form.patchValue({ rotationEnabled: false });
    await component.onSubmit();

    expect(keyChainService.update).toHaveBeenCalledWith('signing', {
      description: 'PID signing',
      rotationPolicy: { enabled: false },
    });
  });

  it('offers no rotation for a standalone key chain that does not rotate', async () => {
    keyChainService.getById.mockResolvedValue(
      keyChain({ type: 'standalone', rotationPolicy: { enabled: false } })
    );
    const { component, page } = await render();

    expect(page.textContent).not.toContain('Rotation Policy');
    await component.onSubmit();

    expect(keyChainService.update).toHaveBeenCalledWith('signing', { description: 'PID signing' });
  });

  it('shows why the key chain could not be loaded, with Retry, instead of leaving the page', async () => {
    keyChainService.getById.mockRejectedValueOnce({ statusCode: 500, message: 'offline' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, page, navigate } = await render();

    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load key chain: offline'
    );
    expect(page.querySelector('form')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    const retry = [...page.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Retry')
    )!;
    retry.click();
    await vi.waitFor(() => expect(fixture.componentInstance.keyChain).toBeDefined());
    fixture.detectChanges();

    expect(page.querySelector('form')).not.toBeNull();
  });
});
