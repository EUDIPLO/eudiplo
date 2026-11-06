import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { JwtService } from '../../services/jwt.service';
import { EditorComponent } from '../../utils/editor/editor.component';
import { EditorStub } from '../../utils/editor/editor.testing';
import { TrustListEditComponent } from './trust-list-edit.component';

describe('TrustListEditComponent', () => {
  let component: TrustListEditComponent;
  let fixture: ComponentFixture<TrustListEditComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrustListEditComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TrustListEditComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('TrustListEditComponent save', () => {
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
  const fetchCalls = (method: string) =>
    fetchStub.mock.calls.filter(([input]) => (input as Request).method === method).length;

  beforeEach(() => {
    snackBar = { open: vi.fn() };
    fetchStub = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const rejected = request.method === 'POST';
      return new Response(
        JSON.stringify(
          rejected
            ? {
                statusCode: 400,
                message: 'Validation failed',
                errors: [
                  { path: ['entities', 0, 'issuerCertPem'], message: 'Invalid PEM' },
                  { path: ['entities', 0, 'info', 'uri'], message: 'Invalid URL' },
                  { path: ['entities', 0, 'type'], message: 'Invalid option' },
                ],
              }
            : []
        ),
        { status: rejected ? 400 : 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    client.setConfig({ fetch: fetchStub });
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('shows rejected fields under the field, and lists the rest', async () => {
    const component = new TrustListEditComponent(
      { snapshot: { paramMap: { get: () => null } } } as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      { get: () => ({ destroyed: true }) } as never
    );
    component.ngOnInit();
    component.form.patchValue({ id: 'trust-list' });
    component.addExternalEntity();
    component.entitiesArray.at(0).patchValue({
      issuerCertPem: 'not a pem',
      revocationCertPem: 'not a pem',
      infoName: 'Example',
    });

    const first = component.onSubmit();
    // A second click while the first save runs sends nothing.
    await component.onSubmit();
    await first;

    expect(fetchCalls('POST')).toBe(1);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to save trust list. Check the highlighted fields. entities.0.type: Invalid option'
    );
    expect(component.fieldError('entities.0.issuerCertPem')).toBe('Invalid PEM');
    expect(component.fieldError('entities.0.infoUri')).toBe('Invalid URL');
    expect(component.saving).toBe(false);

    // The panel opens once and stays open while the user fixes the field.
    const entity = component.entitiesArray.at(0);
    expect(component.rejectedEntities.has(entity)).toBe(true);
    entity.patchValue({ infoUri: 'https://issuer.example' });
    expect(entity.get('infoUri')?.valid).toBe(true);
    expect(component.rejectedEntities.has(entity)).toBe(true);
  });
});

describe('TrustListEditComponent loading the trust list', () => {
  const trustList = {
    id: 'membership-issuers',
    tenantId: 'membership-demo',
    description: 'Issuers accepted for membership checks',
    keyChainId: 'trust-list-signing',
    entityConfig: [
      {
        type: 'internal',
        providerType: 'attestation-provider',
        issuerKeyChainId: 'issuer-keys',
        revocationKeyChainId: 'status-keys',
        info: { name: 'Own Issuer' },
      },
      {
        type: 'external',
        providerType: 'wallet-provider',
        issuerCertPem: 'issuer pem',
        revocationCertPem: 'revocation pem',
        info: { name: 'Example Wallet Provider' },
      },
    ],
  };
  const keyChains = [
    { id: 'issuer-keys', usageType: 'attestation', description: 'Issuer keys' },
    { id: 'status-keys', usageType: 'statusList' },
    { id: 'trust-list-signing', usageType: 'trustList' },
  ];
  const failure = { statusCode: 500, message: 'Internal server error' };

  /** What the backend answers: a body, or a status with the failure body; `null` never answers. */
  type Answer = { status: number; body: object } | null;
  let answers: { trustList: Answer; keyChains: Answer };
  let keyChainRequests: number;

  function json(answer: { status: number; body: object }): Response {
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(() => {
    answers = {
      trustList: { status: 200, body: trustList },
      keyChains: { status: 200, body: keyChains },
    };
    keyChainRequests = 0;
    client.setConfig({
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const isKeyChains = path.endsWith('/api/key-chain');
        if (isKeyChains) keyChainRequests++;
        const answer = isKeyChains ? answers.keyChains : answers.trustList;
        return answer ? json(answer) : new Promise<Response>(() => undefined);
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  /** Opens the edit page of the trust list under its real route. */
  async function render() {
    await TestBed.configureTestingModule({
      imports: [TrustListEditComponent],
      providers: [
        provideRouter([{ path: 'trust-list/:id/edit', component: TrustListEditComponent }]),
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        { provide: JwtService, useValue: { canUseConfigPortability: () => false } },
      ],
    })
      .overrideComponent(TrustListEditComponent, {
        remove: { imports: [EditorComponent] },
        add: { imports: [EditorStub] },
      })
      .compileComponents();
    // The component's MatSnackBarModule provides its own snackbar service.
    const snackBar = vi.spyOn(MatSnackBar.prototype, 'open');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(
      `/trust-list/${trustList.id}/edit`,
      TrustListEditComponent
    );
    const page = harness.routeNativeElement!;
    return { harness, component, page, snackBar, navigate };
  }

  function buttons(page: HTMLElement, text: string): HTMLButtonElement[] {
    return [...page.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
      button.textContent?.trim().endsWith(text)
    );
  }

  /** The text the select of this form control shows. */
  function selected(page: HTMLElement, control: string): string | undefined {
    return page.querySelector(`mat-select[formcontrolname="${control}"]`)?.textContent?.trim();
  }

  function hints(page: HTMLElement, text: string): Element[] {
    return [...page.querySelectorAll('mat-hint')].filter(
      (hint) => hint.textContent?.trim() === text
    );
  }

  it('says it is loading and shows no form until the trust list arrives', async () => {
    answers.trustList = null;
    const { page } = await render();

    // <output> is a status live region, so screen readers announce the loading state.
    expect(page.querySelector('output')?.textContent?.trim()).toBe('Loading trust list…');
    expect(page.querySelector('form')).toBeNull();
    expect(buttons(page, 'Add Internal Entity')).toHaveLength(0);
    expect(page.querySelector('app-load-error')).toBeNull();
  });

  it('stays on the page and says why the trust list could not be loaded', async () => {
    answers.trustList = { status: 500, body: failure };
    const { harness, page, navigate, snackBar } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('app-load-error [role="alert"]')?.textContent).toContain(
        'Failed to load trust list: Internal server error'
      );
    });
    expect(page.querySelector('form')).toBeNull();
    expect(page.querySelector('output')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    // The card's alert says it once; a snackbar would announce it a second time.
    expect(snackBar).not.toHaveBeenCalled();
    const back = page.querySelector('app-load-error a');
    expect(back?.textContent?.trim()).toBe('Back to the list');
    expect(back?.getAttribute('href')).toBe('/trust-list');
  });

  it('shows the stored trust list after a retry and focuses the heading', async () => {
    answers.trustList = { status: 500, body: failure };
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Retry')).toHaveLength(1);
    });

    answers.trustList = { status: 200, body: trustList };
    const retry = buttons(page, 'Retry')[0];
    retry.focus();
    retry.click();
    harness.detectChanges();
    expect(page.querySelector('app-load-error')).toBeNull();
    expect(page.querySelector('output')?.textContent?.trim()).toBe('Loading trust list…');

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
      // The retry removed the focused Retry button with the error card.
      expect(document.activeElement).toBe(page.querySelector('h2'));
    });
    expect(page.querySelector<HTMLInputElement>('input[formcontrolname="id"]')?.value).toBe(
      trustList.id
    );
    // The key chains had loaded, so the retry of the page did not request them again.
    expect(keyChainRequests).toBe(1);
    expect(
      component.entitiesArray.value.map((entity: { infoName: string }) => entity.infoName)
    ).toEqual(['Own Issuer', 'Example Wallet Provider']);
  });

  it('leaves the focus alone when the trust list loads on the first try', async () => {
    const { harness, page } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
    });
    await harness.fixture.whenRenderingDone();
    expect(document.activeElement).not.toBe(page.querySelector('h2'));
  });

  // A defence: the page loads the trust list again only after a failed load, which leaves no entities.
  it('replaces the entities of an earlier load instead of adding to them', async () => {
    const { component } = await render();
    await vi.waitFor(() => expect(component.loading).toBe(false));

    await component.load();

    expect(component.entitiesArray).toHaveLength(2);
  });

  it('says next to the key chain selects that the key chains failed to load', async () => {
    answers.keyChains = { status: 500, body: failure };
    const { harness, component, page, snackBar } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      // The signing key chain and the internal entity's issuer and revocation key chains.
      expect(hints(page, 'Could not load key chains.')).toHaveLength(3);
    });
    expect(snackBar).toHaveBeenCalledWith(
      'Failed to load key chains: Internal server error',
      'Close',
      expect.anything()
    );
    // One retry under the signing key chain, one under the internal entity's key chains.
    expect(buttons(page, 'Retry loading key chains')).toHaveLength(2);
    // The selects show the stored key chains instead of looking empty.
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'keyChainId')).toBe('trust-list-signing');
      expect(selected(page, 'issuerKeyChainId')).toBe('issuer-keys');
      expect(selected(page, 'revocationKeyChainId')).toBe('status-keys');
    });

    // A retry that fails again keeps the button, and the focus on it.
    const retry = buttons(page, 'Retry loading key chains')[1];
    const requests = keyChainRequests;
    retry.focus();
    retry.click();
    // A second click while the first retry runs sends nothing.
    retry.click();
    harness.detectChanges();
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(hints(page, 'Loading key chains…')).toHaveLength(3);
    await vi.waitFor(() => expect(component.loadingKeyChains).toBe(false));
    harness.detectChanges();
    expect(keyChainRequests).toBe(requests + 1);
    expect(buttons(page, 'Retry loading key chains')[1]).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute('aria-busy')).toBe('false');
    expect(snackBar).toHaveBeenCalledTimes(2);

    // Once the key chains are loaded, focus moves to the first select the button was for.
    answers.keyChains = { status: 200, body: keyChains };
    retry.click();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Retry loading key chains')).toHaveLength(0);
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('issuerKeyChainId');
    });
    expect(hints(page, 'Could not load key chains.')).toHaveLength(0);
    expect(component.attestationKeyChains.map((keyChain) => keyChain.id)).toEqual(['issuer-keys']);
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'issuerKeyChainId')).toBe('Issuer keys (issuer-keys)');
    });
    // The stored choices were kept while the key chains could not be loaded.
    expect(component.entitiesArray.at(0).value).toMatchObject({
      issuerKeyChainId: 'issuer-keys',
      revocationKeyChainId: 'status-keys',
    });
  });

  it('shows the stored key chains while the key chains are loading', async () => {
    answers.keyChains = null;
    const { harness, page } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(hints(page, 'Loading key chains…')).toHaveLength(3);
      expect(selected(page, 'keyChainId')).toBe('trust-list-signing');
      expect(selected(page, 'issuerKeyChainId')).toBe('issuer-keys');
    });
  });

  it('says why an empty key chain select is empty once it is touched', async () => {
    answers.keyChains = { status: 500, body: failure };
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(hints(page, 'Could not load key chains.')).toHaveLength(3);
    });

    component.addInternalEntity();
    component.entitiesArray.at(2).get('issuerKeyChainId')?.markAsTouched();
    harness.detectChanges();

    // The error replaces the hint, so it repeats why the select is empty.
    const errors = [...page.querySelectorAll('mat-error')].map((error) =>
      error.textContent?.trim()
    );
    expect(errors).toEqual(['The key chains could not be loaded.']);
  });

  it('asks for a key chain when a required key chain select is left empty', async () => {
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
      expect(component.loadingKeyChains).toBe(false);
    });

    component.addInternalEntity();
    component.entitiesArray.at(2).get('revocationKeyChainId')?.markAsTouched();
    harness.detectChanges();

    const errors = [...page.querySelectorAll('mat-error')].map((error) =>
      error.textContent?.trim()
    );
    expect(errors).toEqual(['Select a key chain.']);
  });

  it('retries the failed key chains with the trust list', async () => {
    answers.trustList = { status: 500, body: failure };
    answers.keyChains = { status: 500, body: failure };
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Retry')).toHaveLength(1);
      expect(component.keyChainsLoadError).not.toBe('');
    });

    answers.trustList = { status: 200, body: trustList };
    answers.keyChains = { status: 200, body: keyChains };
    buttons(page, 'Retry')[0].click();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
      expect(hints(page, 'Could not load key chains.')).toHaveLength(0);
    });
    expect(buttons(page, 'Retry loading key chains')).toHaveLength(0);
  });
});
