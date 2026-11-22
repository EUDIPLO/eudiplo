import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectAvailable, expectUnavailable } from '../../common/unavailable-action.testing';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { KeyChainService } from '../../key-management/key-chain.service';
import { StatusListManagementService } from '../status-list-management.service';
import { StatusListEditComponent } from './status-list-edit.component';

describe('StatusListEditComponent', () => {
  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('names the source that failed, keeps the other select usable and retries it alone', async () => {
    let credentialsFail = true;
    const fetchStub = vi.fn<typeof fetch>(async (input) => {
      const path = new URL((input as Request).url).pathname;
      const failed = path === '/api/issuer/credentials' && credentialsFail;
      return new Response(
        JSON.stringify(
          failed
            ? { statusCode: 403, message: 'Forbidden resource' }
            : [{ id: 'status-keys', usageType: 'statusList' }]
        ),
        { status: failed ? 403 : 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    client.setConfig({ fetch: fetchStub });
    const snackBar = { open: vi.fn() };
    const component = TestBed.runInInjectionContext(
      () =>
        new StatusListEditComponent(
          { snapshot: { paramMap: { get: () => null } } } as never,
          { navigate: vi.fn() } as never,
          snackBar as never,
          {} as never,
          new CredentialConfigService(),
          TestBed.inject(KeyChainService)
        )
    );

    component.ngOnInit();
    await vi.waitFor(() => expect(component.isLoading).toBe(false));

    expect(component.loadState).toEqual({ credentialConfigs: 'failed', keyChains: 'loaded' });
    expect(component.keyChains.map((keyChain) => keyChain.id)).toEqual(['status-keys']);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to load credential configs: Forbidden resource'
    );

    credentialsFail = false;
    fetchStub.mockClear();
    await component.retrySource('credentialConfigs');

    expect(component.loadState.credentialConfigs).toBe('loaded');
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

describe('StatusListEditComponent Save', () => {
  async function render(
    createList: ReturnType<typeof vi.fn>,
    {
      listId = null,
      getList = vi.fn(),
      updateList = vi.fn(),
    }: { listId?: string | null; getList?: unknown; updateList?: unknown } = {}
  ) {
    TestBed.configureTestingModule({
      imports: [StatusListEditComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => listId } } } },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: StatusListManagementService, useValue: { createList, getList, updateList } },
        {
          provide: CredentialConfigService,
          useValue: { loadConfigurations: vi.fn().mockResolvedValue([]) },
        },
        { provide: KeyChainService, useValue: { getAll: vi.fn().mockResolvedValue([]) } },
        {
          provide: ConfigOwnershipService,
          useValue: { get: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(StatusListEditComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    const save = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    )!;
    return { fixture, save };
  }

  afterEach(() => vi.restoreAllMocks());

  it('returns to the list from the back link and Cancel, and marks a capacity preset as a change', async () => {
    const { fixture } = await render(vi.fn());
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toContain('Create Status List');
    expect(element.querySelector('a.back-link')?.getAttribute('href')).toBe('/status-lists');
    expect(element.querySelector('a.back-link')?.getAttribute('aria-label')).toBe(
      'Back to Status Lists'
    );
    const cancel = [...element.querySelectorAll('.action-bar a')].find(
      (link) => link.textContent?.trim() === 'Cancel'
    );
    expect(cancel?.getAttribute('href')).toBe('/status-lists');
    // The section that showFieldsToFix names.
    expect(element.querySelector('#status-list-settings-heading')?.textContent).toBe(
      'Status List Settings'
    );
    expect(element.querySelector('.change-state')?.textContent?.trim()).toBe('');

    [...element.querySelectorAll<HTMLButtonElement>('.presets button')]
      .find((button) => button.textContent?.trim() === '100K')!
      .click();
    fixture.detectChanges();

    expect(fixture.componentInstance.form.value.capacity).toBe(100000);
    expect(element.querySelector('.change-state')?.textContent?.trim()).toBe('Unsaved changes');
  });

  it('marks the chosen capacity preset as pressed', async () => {
    const { fixture } = await render(vi.fn());
    const element = fixture.nativeElement as HTMLElement;
    const preset = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.presets button')].find(
        (button) => button.textContent?.trim() === label
      )!;
    expect(preset('500K').getAttribute('aria-pressed')).toBe('false');

    preset('500K').click();
    fixture.detectChanges();

    expect(preset('500K').getAttribute('aria-pressed')).toBe('true');
    expect(preset('10K').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows an existing status list in edit mode with its stats and no changes', async () => {
    const getList = vi.fn().mockResolvedValue({
      id: 'list-1',
      tenantId: 'tenant',
      capacity: 10000,
      usedEntries: 2500,
      availableEntries: 7500,
      bits: 1,
      uri: 'https://x/status/list-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { fixture } = await render(vi.fn(), { listId: 'list-1', getList });
    const element = fixture.nativeElement as HTMLElement;

    expect(getList).toHaveBeenCalledWith('list-1');
    expect(element.querySelector('h1')?.textContent).toContain('Edit Status List');
    expect(element.querySelector('.stats dd')?.textContent?.trim()).toBe('10.0K');
    expect(element.querySelector('.change-state')?.textContent?.trim()).toBe('No changes');
  });

  it('sends null for a binding changed to Shared or Default and leaves out an unchanged one', async () => {
    const stored = {
      id: 'list-1',
      tenantId: 'tenant',
      capacity: 10000,
      usedEntries: 0,
      availableEntries: 10000,
      bits: 1,
      uri: 'https://x/status/list-1',
      credentialConfigurationId: 'pid',
      keyChainId: 'status-keys',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const updateList = vi.fn().mockResolvedValue(stored);
    const { fixture, save } = await render(vi.fn(), {
      listId: 'list-1',
      getList: vi.fn().mockResolvedValue(stored),
      updateList,
    });

    fixture.componentInstance.form.patchValue({ keyChainId: null });
    save.click();
    await vi.waitFor(() => expect(updateList).toHaveBeenCalledOnce());
    expect(updateList).toHaveBeenLastCalledWith('list-1', { keyChainId: null });

    await vi.waitFor(() => expect(fixture.componentInstance.isSaving).toBe(false));
    fixture.componentInstance.form.patchValue({
      credentialConfigurationId: null,
      keyChainId: 'status-keys',
    });
    save.click();
    await vi.waitFor(() => expect(updateList).toHaveBeenCalledTimes(2));
    expect(updateList).toHaveBeenLastCalledWith('list-1', { credentialConfigurationId: null });
  });

  it('sends no binding for a shared list on the default key chain that was not changed', async () => {
    const updateList = vi.fn().mockResolvedValue({});
    const { save } = await render(vi.fn(), {
      listId: 'list-1',
      getList: vi.fn().mockResolvedValue({
        id: 'list-1',
        tenantId: 'tenant',
        capacity: 10000,
        usedEntries: 0,
        availableEntries: 10000,
        bits: 1,
        uri: 'https://x/status/list-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
      updateList,
    });

    save.click();
    await vi.waitFor(() => expect(updateList).toHaveBeenCalledOnce());

    // A key chain sent again, also as null, would discard the signed list.
    expect(updateList).toHaveBeenCalledWith('list-1', {});
  });

  it('waits while the status list is created: a second click sends nothing', async () => {
    const createList = vi.fn(() => new Promise(() => undefined));
    const { fixture, save } = await render(createList);
    expectAvailable(fixture, save);

    save.click();
    fixture.detectChanges();
    save.click();
    fixture.detectChanges();

    expect(createList).toHaveBeenCalledOnce();
    expect(save.textContent).toContain('Saving…');
    expectUnavailable(fixture, save, 'Saving the status list…');
  });

  it.each([1000, 1_000_000])('creates a status list with a capacity of %s', async (capacity) => {
    const createList = vi.fn(() => new Promise(() => undefined));
    const { fixture, save } = await render(createList);
    fixture.componentInstance.form.patchValue({ capacity });

    save.click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('mat-error')).toBeNull();
    expect(createList).toHaveBeenCalledWith(expect.objectContaining({ capacity }));
  });

  it('says that Capacity keeps it from saving, focuses Capacity and sends nothing', async () => {
    const createList = vi.fn();
    const { fixture, save } = await render(createList);
    // The component's own injector provides the snack bar it uses.
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    fixture.componentInstance.form.patchValue({ capacity: 500 });
    fixture.detectChanges();
    expectAvailable(fixture, save);

    save.focus();
    save.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('capacity');
    });
    expect(open).toHaveBeenLastCalledWith(
      'Check the highlighted fields in Status List Settings.',
      'Close',
      expect.anything()
    );
    expect(createList).not.toHaveBeenCalled();
  });

  it.each([
    [500, 'Capacity must be at least 1,000'],
    [2_000_000, 'Capacity must be at most 1,000,000'],
    [1000.5, 'Enter a whole number of entries'],
  ])('says why it creates no status list with a capacity of %s', async (capacity, error) => {
    const createList = vi.fn();
    const { fixture, save } = await render(createList);
    fixture.componentInstance.form.patchValue({ capacity });

    save.click();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('mat-error')?.textContent?.trim()
    ).toBe(error);
    expect(createList).not.toHaveBeenCalled();
  });
});

describe('StatusListEditComponent key chain options', () => {
  it('names the usage of a key chain as the key pages do', () => {
    const component = TestBed.runInInjectionContext(
      () =>
        new StatusListEditComponent(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never
        )
    );

    expect(component.usageLabel({ usageType: 'statusList' } as never)).toBe('Status List');
    expect(component.usageLabel({ usageType: 'attestation' } as never)).toBe('Credential Signing');
    expect(component.usageLabel({ usageType: 'future' } as never)).toBe('future');
  });
});
