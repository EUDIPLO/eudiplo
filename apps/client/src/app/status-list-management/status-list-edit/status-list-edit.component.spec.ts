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
    const component = new StatusListEditComponent(
      { snapshot: { paramMap: { get: () => null } } } as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      {} as never,
      new CredentialConfigService(),
      TestBed.inject(KeyChainService)
    );

    component.ngOnInit();
    await vi.waitFor(() => expect(component.isLoading).toBe(false));

    expect(component.loadState).toEqual({ credentialConfigs: 'failed', keyChains: 'loaded' });
    expect(component.keyChains.map((keyChain) => keyChain.id)).toEqual(['status-keys']);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to load credential configurations: Forbidden resource'
    );

    credentialsFail = false;
    fetchStub.mockClear();
    await component.retrySource('credentialConfigs');

    expect(component.loadState.credentialConfigs).toBe('loaded');
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

describe('StatusListEditComponent Save', () => {
  async function render(createList: ReturnType<typeof vi.fn>) {
    TestBed.configureTestingModule({
      imports: [StatusListEditComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } } } },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: StatusListManagementService, useValue: { createList } },
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
});
