import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { OidcClientSecretDialogComponent } from '../oidc-client-secret-dialog/oidc-client-secret-dialog.component';
import { OidcClientService } from '../oidc-client.service';
import { OidcClientCreateComponent } from './oidc-client-create.component';

const configs = [
  { id: 'pid', dcql_query: { credentials: [{ id: 'pid', format: 'dc+sd-jwt' }] } },
  {
    id: 'payment',
    dcql_query: { credentials: [{ id: 'pid', format: 'dc+sd-jwt' }] },
    transaction_data: [{ type: 'payment', credential_ids: ['pid'] }],
  },
];

const stored = {
  id: 'c7d1',
  name: 'Portal',
  redirectUris: ['https://portal.example/cb'],
  profile: 'basic' as const,
  scopes: [{ scope: 'pid', presentationConfigId: 'pid' }],
  secrets: [],
  subject: { credentialId: 'pid', claim: 'personal_administrative_number' },
  claimsFrom: 'pid',
  issuer: 'https://eudiplo.example/verifiers/root/oidc',
};

async function render(
  id: string | null,
  service: Partial<OidcClientService>,
  loadConfigurations: () => Promise<unknown> = async () => configs
) {
  const open = vi.fn();
  const snackBar = { open: vi.fn() };
  const navigate = vi.fn().mockResolvedValue(true);
  await TestBed.configureTestingModule({
    imports: [OidcClientCreateComponent],
    providers: [
      provideRouter([]),
      { provide: OidcClientService, useValue: service },
      {
        provide: PresentationManagementService,
        useValue: { loadConfigurations: vi.fn(loadConfigurations) },
      },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } },
      },
      { provide: MatDialog, useValue: { open } },
      { provide: MatSnackBar, useValue: snackBar },
    ],
  }).compileComponents();
  TestBed.inject(Router).navigate = navigate;
  const fixture = TestBed.createComponent(OidcClientCreateComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, open, navigate, snackBar };
}

function fillValid(component: OidcClientCreateComponent): void {
  component.form.patchValue({ name: 'Portal' });
  component.redirectUris.at(0).setValue('https://portal.example/cb');
  component.scopes.at(0).setValue({ scope: 'pid', presentationConfigId: 'pid' });
}

describe('OidcClientCreateComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('leads back to the list from a new client and to the client from an edit', async () => {
    const created = await render(null, {});
    const page = created.fixture.nativeElement as HTMLElement;
    expect(page.querySelector('a.back-link')?.getAttribute('aria-label')).toBe(
      'Back to OIDC Clients'
    );
    expect(page.querySelector('h1')?.textContent?.trim()).toBe('Create OIDC Client');
    TestBed.resetTestingModule();

    const edited = await render('c7d1', { getById: vi.fn().mockResolvedValue(stored) });
    edited.fixture.detectChanges();
    const editPage = edited.fixture.nativeElement as HTMLElement;
    expect(editPage.querySelector('a.back-link')?.getAttribute('aria-label')).toBe(
      'Back to Portal'
    );
    expect(editPage.querySelector('h1')?.textContent?.trim()).toBe('Edit OIDC Client');
    const cancel = [...editPage.querySelectorAll<HTMLButtonElement>('.action-bar button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    );
    expect(cancel).toBeDefined();
  });

  it('keeps Cancel on the page while a save runs', async () => {
    const { fixture, component } = await render(null, {});
    component.saving = true;
    fixture.detectChanges();
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const cancel = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.action-bar button'
      ),
    ].find((button) => button.textContent?.trim() === 'Cancel')!;

    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    cancel.click();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('shows the back link while the client to edit loads', async () => {
    const { fixture } = await render('c7d1', { getById: () => new Promise(() => undefined) });
    const page = fixture.nativeElement as HTMLElement;

    expect(page.querySelector('a.back-link')?.getAttribute('aria-label')).toBe(
      'Back to OIDC client'
    );
    expect(page.textContent).toContain('Loading OIDC client…');
  });

  it('creates a client, opens its page and shows the secret once', async () => {
    const create = vi.fn().mockResolvedValue({ ...stored, clientSecret: 's3cret' });
    const { component, open, navigate } = await render(null, { create });

    component.form.patchValue({ name: ' Portal ' });
    component.redirectUris.at(0).setValue('https://portal.example/cb');
    component.scopes.at(0).setValue({ scope: 'pid', presentationConfigId: 'pid' });
    component.onSubmit();

    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: 'Portal',
      profile: 'secure',
      redirectUris: ['https://portal.example/cb'],
      scopes: [{ scope: 'pid', presentationConfigId: 'pid' }],
      subject: null,
      claimsFrom: null,
    });
    expect(navigate).toHaveBeenCalledWith(['../', 'c7d1'], expect.anything());
    expect(open).toHaveBeenCalledWith(OidcClientSecretDialogComponent, {
      data: { clientId: 'c7d1', clientSecret: 's3cret', issuer: stored.issuer },
      disableClose: true,
    });
  });

  it('does not send a form with an HTTP redirect URI or a reserved scope', async () => {
    const create = vi.fn();
    const { component } = await render(null, { create });

    component.form.patchValue({ name: 'Portal' });
    component.redirectUris.at(0).setValue('http://portal.example/cb');
    component.scopes.at(0).setValue({ scope: 'openid', presentationConfigId: 'pid' });
    component.onSubmit();

    expect(create).not.toHaveBeenCalled();
    // The template passes a message for an empty field; the validator's own message wins.
    expect(component.fieldError(['redirectUris', 0], 'A redirect URI is required')).toContain(
      'HTTPS'
    );
    expect(component.fieldError(['scopes', 0, 'scope'], 'A scope is required')).toContain(
      'reserved'
    );
  });

  it('fills the form of a stored client and sends every field on update', async () => {
    const update = vi.fn().mockResolvedValue(stored);
    const { component, navigate } = await render('c7d1', {
      getById: vi.fn().mockResolvedValue(stored),
      update,
    });

    expect(component.form.controls.useSubject.value).toBe(true);
    expect(component.subjectCredentialIds).toEqual(['pid']);

    component.form.controls.useSubject.setValue(false);
    component.onSubmit();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('c7d1', {
      name: 'Portal',
      profile: 'basic',
      redirectUris: ['https://portal.example/cb'],
      scopes: [{ scope: 'pid', presentationConfigId: 'pid' }],
      subject: null,
      claimsFrom: 'pid',
    });
  });

  it('disables a config with transaction data in the scope select, with the reason', async () => {
    const { fixture } = await render(null, {});
    const element = fixture.nativeElement as HTMLElement;

    (
      element.querySelector('mat-select[formControlName="presentationConfigId"]') as HTMLElement
    ).click();
    fixture.detectChanges();
    await fixture.whenStable();

    const options = Array.from(document.querySelectorAll('mat-option'));
    const payment = options.find((option) => option.textContent?.includes('payment'));
    expect(payment?.textContent).toContain('(defines transaction data)');
    expect(payment?.getAttribute('aria-disabled')).toBe('true');
    const pid = options.find((option) => option.textContent?.trim() === 'pid');
    expect(pid?.getAttribute('aria-disabled')).toBe('false');
  });

  it('shows the backend issues at their fields and stays on the page when the save fails', async () => {
    const create = vi.fn().mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: [{ path: ['scopes', 0, 'presentationConfigId'], message: 'Unknown config' }],
    });
    const { component, open, navigate, snackBar } = await render(null, { create });
    fillValid(component);

    component.onSubmit();

    await vi.waitFor(() => expect(component.saving).toBe(false));
    expect(component.fieldError(['scopes', 0, 'presentationConfigId'])).toBe('Unknown config');
    expect(snackBar.open.mock.calls.at(-1)?.[0]).toContain('Failed to create OIDC client');
    expect(navigate).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the secret even when opening the new client page fails', async () => {
    const create = vi.fn().mockResolvedValue({ ...stored, clientSecret: 's3cret' });
    const { component, open, navigate } = await render(null, { create });
    navigate.mockRejectedValue(new Error('chunk failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fillValid(component);

    component.onSubmit();

    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0][1].data.clientSecret).toBe('s3cret');
  });

  it('checks the subject fields only while the stable subject is on, and sends them trimmed', async () => {
    const create = vi.fn().mockResolvedValue({ ...stored, clientSecret: 's' });
    const { component } = await render(null, { create });
    fillValid(component);

    component.form.controls.useSubject.setValue(true);
    component.onSubmit();
    expect(create).not.toHaveBeenCalled();

    component.form.controls.useSubject.setValue(false);
    component.onSubmit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].subject).toBeNull();
    await vi.waitFor(() => expect(component.saving).toBe(false));

    component.form.controls.useSubject.setValue(true);
    component.form.controls.subject.setValue({ credentialId: 'pid', claim: ' pan ' });
    component.onSubmit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].subject).toEqual({ credentialId: 'pid', claim: 'pan' });
  });

  it.each([
    ['name', (c: OidcClientCreateComponent) => c.form.controls.name],
    ['scope', (c: OidcClientCreateComponent) => c.scopes.at(0).controls.scope],
    ['redirect URI', (c: OidcClientCreateComponent) => c.redirectUris.at(0)],
  ])('does not send a %s of blanks', async (_, field) => {
    const create = vi.fn();
    const { component } = await render(null, { create });
    fillValid(component);
    field(component).setValue('   ');

    component.onSubmit();

    expect(create).not.toHaveBeenCalled();
    expect(field(component).hasError('required')).toBe(true);
  });

  it('does not save while the client to edit loads or after it failed to load', async () => {
    const update = vi.fn();
    const pending = await render('c7d1', { getById: () => new Promise(() => undefined), update });
    pending.component.onSubmit();
    TestBed.resetTestingModule();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await render('c7d1', {
      getById: vi.fn().mockRejectedValue({ statusCode: 500, message: 'x' }),
      update,
    });
    await vi.waitFor(() => expect(failed.component.loadError).not.toBe(''));
    failed.component.onSubmit();

    expect(update).not.toHaveBeenCalled();
  });

  it('shows the backend issues of a failed update and stays on the page', async () => {
    const { component, navigate, snackBar } = await render('c7d1', {
      getById: vi.fn().mockResolvedValue(stored),
      update: vi.fn().mockRejectedValue({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ path: ['name'], message: 'Too long' }],
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    component.onSubmit();

    await vi.waitFor(() => expect(component.saving).toBe(false));
    expect(component.fieldError('name')).toBe('Too long');
    expect(snackBar.open.mock.calls.at(-1)?.[0]).toContain('Failed to update OIDC client');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not offer a subject query without a trusted authority', async () => {
    const trusted = {
      id: 'trusted',
      dcql_query: {
        credentials: [
          {
            id: 'pid',
            format: 'dc+sd-jwt',
            trusted_authorities: [{ type: 'etsi_tl', values: [{ trustListId: 'pid' }] }],
          },
        ],
      },
    };
    const { component } = await render(null, {}, async () => [...configs, trusted]);
    component.scopes.at(0).setValue({ scope: 'pid', presentationConfigId: 'pid' });
    expect(component.subjectQueryProblem('pid')).toBe('no trusted authority');

    component.scopes.at(0).setValue({ scope: 'pid', presentationConfigId: 'trusted' });
    expect(component.subjectQueryProblem('pid')).toBe('');
  });

  it('keeps stored values selectable while the verification configs load', async () => {
    const { component } = await render(
      'c7d1',
      { getById: vi.fn().mockResolvedValue(stored) },
      () => new Promise(() => undefined)
    );

    expect(component.configsPending).toBe(true);
    expect(component.pendingSubjectCredentialId).toBe('pid');
    expect(component.pendingClaimsFrom).toBe('pid');
    expect(component.staleClaimsFrom).toBe('');
  });

  it('adds no redirect URI or scope beyond the limit', async () => {
    const { component } = await render(null, {});
    for (let i = 0; i < 25; i++) {
      component.addRedirectUri();
      component.addScope();
    }

    expect(component.redirectUris.length).toBe(20);
    expect(component.scopes.length).toBe(20);
  });

  it('counts a removed redirect URI or scope as unsaved changes', async () => {
    const { component } = await render(null, {});
    component.addRedirectUri();
    component.addScope();

    component.form.markAsPristine();
    component.removeRedirectUri(1);
    expect(component.hasUnsavedChanges()).toBe(true);

    component.form.markAsPristine();
    expect(component.hasUnsavedChanges()).toBe(false);
    component.removeScope(1);
    expect(component.hasUnsavedChanges()).toBe(true);
  });

  it('marks a top-level claims query that no scope has any more', async () => {
    const { component } = await render('c7d1', { getById: vi.fn().mockResolvedValue(stored) });
    expect(component.staleClaimsFrom).toBe('');

    component.removeScope(0);

    expect(component.staleClaimsFrom).toBe('pid');
    expect(component.staleSubjectCredentialId).toBe('pid');
  });

  it('says when the verification configs cannot be loaded, and retries', async () => {
    let calls = 0;
    const { component } = await render(null, {}, async () => {
      calls += 1;
      if (calls === 1) throw { statusCode: 500, message: 'down' };
      return configs;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await vi.waitFor(() =>
      expect(component.configsError).toBe('Failed to load the verification configs: down')
    );
    component.loadConfigs(true);
    await vi.waitFor(() => expect(component.configs).toHaveLength(2));
    expect(component.configsError).toBe('');
  });

  it('links to creating a verification config when the tenant has none', async () => {
    const { fixture } = await render(null, {}, async () => []);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.textContent).toContain('This tenant has no verification configs yet.');
    expect(element.querySelector('a[href="/presentation-config/create"]')?.textContent).toContain(
      'Create a verification config'
    );
  });

  it('keeps the form hidden when the client cannot be loaded', async () => {
    const { component, fixture } = await render('c7d1', {
      getById: vi.fn().mockRejectedValue({ statusCode: 404, message: 'Not found' }),
    });
    await vi.waitFor(() =>
      expect(component.loadError).toBe('Failed to load OIDC client: Not found')
    );
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
  });
});
