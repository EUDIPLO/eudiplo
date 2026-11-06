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
            : // The tenant's key chains: one can sign the trust list.
              [{ id: 'trust-list-signing', usageType: 'trustList' }]
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

  /** Opens the edit page of the trust list, or the page at `url`, under its real route. */
  async function render(url = `/trust-list/${trustList.id}/edit`) {
    await TestBed.configureTestingModule({
      imports: [TrustListEditComponent],
      providers: [
        provideRouter([
          { path: 'trust-list/create', component: TrustListEditComponent },
          { path: 'trust-list/:id/edit', component: TrustListEditComponent },
        ]),
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
    const component = await harness.navigateByUrl(url, TrustListEditComponent);
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

  it('says why an internal entity has no key chain to select, and links to create one', async () => {
    // Only the external entity is stored, and the tenant has no key chains besides the one that
    // signs the trust list.
    answers.trustList = {
      status: 200,
      body: { ...trustList, entityConfig: [trustList.entityConfig[1]] },
    };
    answers.keyChains = { status: 200, body: [keyChains[2]] };
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
      expect(component.loadingKeyChains).toBe(false);
    });

    buttons(page, 'Add Internal Entity')[0].click();
    harness.detectChanges();

    const noIssuer = 'No credential signing key chains. Create one in Key Management.';
    const noRevocation =
      'No status list or credential signing key chains. Create one in Key Management.';
    expect(hints(page, noIssuer)).toHaveLength(1);
    expect(hints(page, noRevocation)).toHaveLength(1);
    // The signing key chain select has its key chain, so it keeps its usual hint and gets no link.
    expect(hints(page, 'Key chain used to sign the trust list JWT')).toHaveLength(1);
    expect(hints(page, 'No trust list key chains. Create one in Key Management.')).toHaveLength(0);
    // The links open in a new tab, so the form keeps what was entered.
    const links = [...page.querySelectorAll<HTMLAnchorElement>('a[href^="/keys/create"]')];
    expect(
      links.map((link) => [link.getAttribute('href'), link.target, link.textContent?.trim()])
    ).toEqual([
      [
        '/keys/create?usage=attestation&from=form',
        '_blank',
        expect.stringMatching(/Create credential signing key chain\s+\(opens in a new tab\)$/),
      ],
      [
        '/keys/create?usage=statusList&from=form',
        '_blank',
        expect.stringMatching(/Create status list key chain\s+\(opens in a new tab\)$/),
      ],
    ]);
    expect(buttons(page, 'Reload key chains')).toHaveLength(1);
    expect(buttons(page, 'Retry loading key chains')).toHaveLength(0);

    // Once touched, the error replaces the hint and repeats why the select is empty, and the
    // empty selects are what keeps Save disabled.
    const entity = component.entitiesArray.at(1);
    entity.patchValue({ infoName: 'Own Issuer' });
    entity.get('issuerKeyChainId')?.markAsTouched();
    entity.get('revocationKeyChainId')?.markAsTouched();
    harness.detectChanges();
    const errors = [...page.querySelectorAll('mat-error')].map((error) =>
      error.textContent?.trim()
    );
    expect(errors).toEqual([noIssuer, noRevocation]);
    expect(component.form.invalid).toBe(true);
    expect(buttons(page, 'Save Changes')[0].disabled).toBe(true);
  });

  it('on create, says that no trust list key chain can sign the list, and links to create one', async () => {
    answers.trustList = null;
    answers.keyChains = { status: 200, body: [keyChains[0], keyChains[1]] };
    const { harness, component, page } = await render('/trust-list/create');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Reload key chains')).toHaveLength(1);
    });
    // Without a selection, a create signs with a trust list key chain of the tenant, of which
    // there is none, so saving would fail.
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'keyChainId')).toBe('Any trust list key chain of the tenant');
    });
    // So the form cannot be sent. The select looks filled in, so instead of a hint it shows the
    // reason as its error at once, without being touched first.
    const signing = component.form.get('keyChainId')!;
    expect(signing.hasError('signingKeyChain')).toBe(true);
    const errors = () =>
      [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim());
    expect(errors()).toEqual(['No trust list key chains. Create one in Key Management.']);
    expect(hints(page, 'Key chain used to sign the trust list JWT')).toHaveLength(0);
    const links = [...page.querySelectorAll<HTMLAnchorElement>('a[href^="/keys/create"]')];
    expect(
      links.map((link) => [link.getAttribute('href'), link.target, link.textContent?.trim()])
    ).toEqual([
      [
        '/keys/create?usage=trustList&from=form',
        '_blank',
        expect.stringMatching(/Create trust list key chain\s+\(opens in a new tab\)$/),
      ],
    ]);

    // Created in the other tab: Reload removes the error, the link and itself, and focus moves to
    // the signing key chain select.
    answers.keyChains = { status: 200, body: keyChains };
    const reload = buttons(page, 'Reload key chains')[0];
    reload.focus();
    reload.click();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Reload key chains')).toHaveLength(0);
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('keyChainId');
    });
    expect(page.querySelector('a[href^="/keys/create"]')).toBeNull();
    expect(hints(page, 'Key chain used to sign the trust list JWT')).toHaveLength(1);
    expect(errors()).toEqual([]);
    expect(signing.value).toBe('');
    expect(signing.valid).toBe(true);
  });

  it('on edit, the empty signing option keeps the current trust list key chain', async () => {
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
      expect(component.loadingKeyChains).toBe(false);
    });

    const signing = component.form.get('keyChainId')!;
    signing.setValue('');
    signing.markAsTouched();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'keyChainId')).toBe('Keep the current key chain');
    });
    expect(hints(page, 'Key chain used to sign the trust list JWT')).toHaveLength(1);
    expect(signing.valid).toBe(true);
    expect(page.querySelector('a[href^="/keys/create"]')).toBeNull();

    // Saving leaves keyChainId out, so the backend keeps the current key chain.
    const sent: Request[] = [];
    client.setConfig({
      fetch: async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        sent.push(request.clone());
        return json({ status: 200, body: trustList });
      },
    });
    await component.onSubmit();
    const update = sent.find((request) => request.method === 'PUT');
    expect(new URL(update!.url).pathname).toMatch(/\/api\/trust-list\/membership-issuers$/);
    const body = (await update!.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('keyChainId');
    expect(body['entities']).toHaveLength(2);
  });

  it('on edit, does not save with a signing key chain of another usage, selected or kept', async () => {
    // The current signing key chain now signs credentials, so the tenant has no trust list key
    // chain, and an update that names it or keeps it fails.
    answers.keyChains = {
      status: 200,
      body: [keyChains[0], keyChains[1], { id: 'trust-list-signing', usageType: 'attestation' }],
    };
    const { harness, component, page } = await render();
    const errors = () =>
      [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim());
    // The select looks filled in, so it shows why at once, without being touched first.
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(errors()).toEqual([
        'This is not a trust list key chain, so saving fails. Choose another.',
      ]);
    });
    const signing = component.form.get('keyChainId')!;
    expect(signing.hasError('signingKeyChain')).toBe(true);
    expect(buttons(page, 'Save Changes')[0].disabled).toBe(true);

    // Keeping the current key chain keeps the same key chain, so it fails the same way.
    signing.setValue('');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'keyChainId')).toBe('Keep the current key chain');
    });
    expect(errors()).toEqual([
      'The current key chain is not a trust list key chain, so saving fails. Choose another.',
    ]);
    expect(signing.hasError('signingKeyChain')).toBe(true);
    expect(
      [...page.querySelectorAll('a[href^="/keys/create"]')].map((link) => link.getAttribute('href'))
    ).toEqual(['/keys/create?usage=trustList&from=form']);
    expect(buttons(page, 'Reload key chains')).toHaveLength(1);
  });

  it('on edit, does not save with a signing key chain that no longer exists, selected or kept', async () => {
    answers.keyChains = { status: 200, body: [keyChains[0], keyChains[1]] };
    const { harness, component, page } = await render();
    const errors = () =>
      [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim());
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(errors()).toEqual(['This key chain does not exist, so saving fails. Choose another.']);
    });

    component.form.get('keyChainId')!.setValue('');
    harness.detectChanges();
    expect(errors()).toEqual([
      'The current key chain does not exist, so saving fails. Choose another.',
    ]);
    expect(component.form.get('keyChainId')!.invalid).toBe(true);
  });

  it('shows the signing key chain error at once when the trust list arrives after the key chains', async () => {
    answers.keyChains = { status: 200, body: [keyChains[0], keyChains[1]] };
    let releaseTrustList!: () => void;
    const trustListArrives = new Promise<void>((resolve) => (releaseTrustList = resolve));
    client.setConfig({
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith('/api/key-chain')) return json(answers.keyChains!);
        await trustListArrives;
        return json(answers.trustList!);
      },
    });
    const { harness, component, page } = await render();
    await vi.waitFor(() => expect(component.attestationKeyChains).toHaveLength(1));

    releaseTrustList();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(
        [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim())
      ).toEqual(['This key chain does not exist, so saving fails. Choose another.']);
    });
  });

  it('keeps an issue the backend put at the signing key chain when the key chains reload', async () => {
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('form')).not.toBeNull();
      expect(component.loadingKeyChains).toBe(false);
    });
    const signing = component.form.get('keyChainId')!;
    signing.setErrors({ server: 'Rejected by the backend' });

    // The user returns from creating a key chain in another tab.
    component.openKeyChainCreation(page);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(keyChainRequests).toBe(2));
    await vi.waitFor(() => expect(component.loadingKeyChains).toBe(false));

    expect(component.fieldError('keyChainId')).toBe('Rejected by the backend');
    // Editing the field removes it.
    signing.setValue('');
    expect(component.fieldError('keyChainId')).toBe('');
  });

  it('on create, does not block an empty signing key chain while the key chains are unknown', async () => {
    answers.trustList = null;
    answers.keyChains = { status: 200, body: [keyChains[0], keyChains[1]] };
    const { harness, component, page } = await render('/trust-list/create');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Reload key chains')).toHaveLength(1);
    });
    const signing = component.form.get('keyChainId')!;
    expect(signing.hasError('signingKeyChain')).toBe(true);

    // After a failed reload nothing is known about the key chains, so the select only says that
    // and offers a retry; the backend answers for a save.
    answers.keyChains = { status: 500, body: failure };
    buttons(page, 'Reload key chains')[0].click();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Retry loading key chains')).toHaveLength(1);
    });
    expect(signing.valid).toBe(true);
    expect(hints(page, 'Could not load key chains.')).toHaveLength(1);
    expect(page.querySelector('a[href^="/keys/create"]')).toBeNull();
  });

  it('reloads the key chains after one was created, keeping the focus while one is missing', async () => {
    // Neither a credential signing nor a status list key chain exists.
    answers.keyChains = { status: 200, body: [keyChains[2]] };
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Reload key chains')).toHaveLength(1);
    });
    const createLinks = () =>
      [...page.querySelectorAll('a[href^="/keys/create"]')].map((link) =>
        link.getAttribute('href')
      );
    expect(createLinks()).toEqual([
      '/keys/create?usage=attestation&from=form',
      '/keys/create?usage=statusList&from=form',
    ]);
    const header = () => page.querySelector('mat-panel-description')?.textContent?.trim();
    // The stored issuer key chain is not among the loaded ones.
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'issuerKeyChainId')).toBe('issuer-keys (does not exist)');
    });
    expect(header()).toBe('Check the selected key chains');

    // A reload that fails keeps the button, now to retry, and the focus on it. Nothing is known
    // about the key chains then, so the links go and the stored key chain gets no reason.
    answers.keyChains = { status: 500, body: failure };
    const reload = buttons(page, 'Reload key chains')[0];
    reload.focus();
    reload.click();
    harness.detectChanges();
    expect(reload.getAttribute('aria-busy')).toBe('true');
    expect(hints(page, 'Loading key chains…')).toHaveLength(3);
    await vi.waitFor(() => expect(component.loadingKeyChains).toBe(false));
    harness.detectChanges();
    expect(buttons(page, 'Retry loading key chains')).toContain(reload);
    expect(createLinks()).toEqual([]);
    expect(document.activeElement).toBe(reload);
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'issuerKeyChainId')).toBe('issuer-keys');
    });
    expect(header()).toBe('Using system certificates');

    // A status list key chain was created in the other tab; the issuer still has none, so the
    // same button stays to reload, with the focus on it.
    answers.keyChains = { status: 200, body: [keyChains[1], keyChains[2]] };
    reload.click();
    await vi.waitFor(() => expect(component.loadingKeyChains).toBe(false));
    harness.detectChanges();
    expect(createLinks()).toEqual(['/keys/create?usage=attestation&from=form']);
    expect(buttons(page, 'Reload key chains')).toEqual([reload]);
    expect(document.activeElement).toBe(reload);

    // With both created, the links and the button are gone and focus moves to the first select.
    answers.keyChains = { status: 200, body: keyChains };
    reload.click();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Reload key chains')).toHaveLength(0);
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('issuerKeyChainId');
    });
    expect(page.querySelector('a[href^="/keys/create"]')).toBeNull();
    expect(hints(page, 'Key chain used for credential signing')).toHaveLength(1);
    expect(hints(page, 'Key chain used for status list signing')).toHaveLength(1);
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'issuerKeyChainId')).toBe('Issuer keys (issuer-keys)');
      expect(selected(page, 'revocationKeyChainId')).toBe('status-keys');
    });
    expect(header()).toBe('Using system certificates');
  });

  /** Opens the select of this form control and reads its option groups and options. */
  async function openOptions(harness: RouterTestingHarness, page: HTMLElement, control: string) {
    page.querySelector<HTMLElement>(`mat-select[formcontrolname="${control}"]`)!.click();
    let options: (string | undefined)[] = [];
    await vi.waitFor(() => {
      harness.detectChanges();
      options = [...document.querySelectorAll('mat-option')].map((option) =>
        option.textContent?.trim()
      );
      expect(options.length).toBeGreaterThan(0);
    });
    const groups = [...document.querySelectorAll('mat-optgroup .mat-mdc-optgroup-label')].map(
      (label) => label.textContent?.trim()
    );
    return { groups, options };
  }

  /** The stored list, whose internal entity uses its credential signing key chain for revocation. */
  const revokedWithIssuerKeys = {
    status: 200,
    body: {
      ...trustList,
      entityConfig: [
        { ...trustList.entityConfig[0], revocationKeyChainId: 'issuer-keys' },
        trustList.entityConfig[1],
      ],
    },
  };

  it('offers credential signing key chains for revocation when no status list key chain exists', async () => {
    answers.trustList = revokedWithIssuerKeys;
    answers.keyChains = { status: 200, body: [keyChains[0], keyChains[2]] };
    const { harness, component, page } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(component.loadingKeyChains).toBe(false);
      expect(selected(page, 'revocationKeyChainId')).toBe('Issuer keys (issuer-keys)');
    });
    // They sign the status lists then, so the select offers them and says why.
    expect(
      hints(
        page,
        'No status list key chains, so a credential signing key chain signs the status lists.'
      )
    ).toHaveLength(1);
    expect(page.querySelector('mat-panel-description')?.textContent?.trim()).toBe(
      'Using system certificates'
    );
    // The select is not empty, so nothing asks for a status list key chain.
    expect(page.querySelector('a[href^="/keys/create"]')).toBeNull();
    expect(buttons(page, 'Reload key chains')).toHaveLength(0);
    // Only credential signing key chains, under their own heading; not the trust list key chain.
    expect(await openOptions(harness, page, 'revocationKeyChainId')).toEqual({
      groups: ['Credential signing key chains'],
      options: ['Issuer keys (issuer-keys)'],
    });
  });

  it('offers credential signing key chains after the status list ones, for pinned status lists', async () => {
    answers.trustList = revokedWithIssuerKeys;
    const { harness, component, page } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(component.loadingKeyChains).toBe(false);
      expect(selected(page, 'revocationKeyChainId')).toBe('Issuer keys (issuer-keys)');
    });
    // The backend accepts it, so no reason and no "check" in the header, but the hint says which
    // status lists it signs.
    const pinnedOnly =
      'A credential signing key chain signs only the status lists pinned to it; the others are signed by a status list key chain.';
    expect(hints(page, pinnedOnly)).toHaveLength(1);
    expect(page.querySelector('mat-panel-description')?.textContent?.trim()).toBe(
      'Using system certificates'
    );

    // Choosing a status list key chain drops the hint, and the credential signing key chain stays
    // offered, so the choice can be undone.
    component.entitiesArray.at(0).get('revocationKeyChainId')?.setValue('status-keys');
    harness.detectChanges();
    expect(hints(page, pinnedOnly)).toHaveLength(0);
    expect(hints(page, 'Key chain used for status list signing')).toHaveLength(1);
    // Status list key chains first, then the credential signing ones under their own heading.
    expect(await openOptions(harness, page, 'revocationKeyChainId')).toEqual({
      groups: [
        'Status list key chains',
        'Credential signing key chains (for status lists pinned to them)',
      ],
      options: ['status-keys', 'Issuer keys (issuer-keys)'],
    });
  });

  it('says why a stored revocation key chain of another usage type is not offered', async () => {
    answers.trustList = {
      status: 200,
      body: {
        ...trustList,
        entityConfig: [
          { ...trustList.entityConfig[0], revocationKeyChainId: 'trust-list-signing' },
          trustList.entityConfig[1],
        ],
      },
    };
    const { harness, page } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'revocationKeyChainId')).toBe(
        'trust-list-signing (not a status list or credential signing key chain)'
      );
    });
    expect(
      hints(
        page,
        'This is not a status list or credential signing key chain; saving still puts its certificate in the trust list. Choose another.'
      )
    ).toHaveLength(1);
    expect(page.querySelector('mat-panel-description')?.textContent?.trim()).toBe(
      'Check the selected key chains'
    );
  });

  it('says why a stored key chain is not among the loaded key chains', async () => {
    // issuer-keys now signs status lists, trust-list-signing signs credentials, status-keys is gone.
    answers.keyChains = {
      status: 200,
      body: [
        { id: 'issuer-keys', usageType: 'statusList' },
        { id: 'trust-list-signing', usageType: 'attestation' },
      ],
    };
    const { harness, component, page } = await render();

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(selected(page, 'keyChainId')).toBe('trust-list-signing (not a trust list key chain)');
      expect(selected(page, 'issuerKeyChainId')).toBe(
        'issuer-keys (not a credential signing key chain)'
      );
      expect(selected(page, 'revocationKeyChainId')).toBe('status-keys (does not exist)');
    });
    // The select shows what Save sends, and its hint what saving does with it.
    expect(component.form.get('keyChainId')?.value).toBe('trust-list-signing');
    expect(component.entitiesArray.at(0).value).toMatchObject({
      issuerKeyChainId: 'issuer-keys',
      revocationKeyChainId: 'status-keys',
    });
    // Saving fails with that signing key chain, so its select shows that as its error.
    expect(
      [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim())
    ).toEqual(['This is not a trust list key chain, so saving fails. Choose another.']);
    expect(
      hints(
        page,
        'This is not a credential signing key chain; saving still puts its certificate in the trust list. Choose another.'
      )
    ).toHaveLength(1);
    expect(
      hints(page, 'This key chain does not exist, so saving fails. Choose another.')
    ).toHaveLength(1);
    // The first entity's panel is collapsed, so its header says the key chains need a look.
    const descriptions = [...page.querySelectorAll('mat-panel-description')].map((description) =>
      description.textContent?.trim()
    );
    expect(descriptions).toEqual([
      'Check the selected key chains',
      'Using external PEM certificates',
    ]);
  });

  it('reloads the key chains once the user returns from creating one in another tab', async () => {
    answers.keyChains = { status: 200, body: [keyChains[2]] };
    const { harness, component, page } = await render();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(buttons(page, 'Reload key chains')).toHaveLength(1);
    });
    // Returning to the tab without having followed a create link loads nothing; a reload would
    // set loadingKeyChains at once.
    window.dispatchEvent(new Event('focus'));
    expect(component.loadingKeyChains).toBe(false);

    const link = page.querySelector<HTMLAnchorElement>(
      'a[href="/keys/create?usage=attestation&from=form"]'
    )!;
    // The test opens no tab.
    link.addEventListener('click', (event) => event.preventDefault());
    link.focus();
    link.click();
    answers.keyChains = { status: 200, body: keyChains };
    window.dispatchEvent(new Event('focus'));

    // Both key chains exist now, so the links are gone and focus moves to the first select.
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(page.querySelector('a[href^="/keys/create"]')).toBeNull();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('issuerKeyChainId');
    });
    expect(keyChainRequests).toBe(2);
    // Only the first return reloads.
    window.dispatchEvent(new Event('focus'));
    expect(component.loadingKeyChains).toBe(false);
    expect(keyChainRequests).toBe(2);
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
