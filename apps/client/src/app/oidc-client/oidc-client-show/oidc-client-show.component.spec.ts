import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OidcClientSecretDialogComponent } from '../oidc-client-secret-dialog/oidc-client-secret-dialog.component';
import { JwtService } from '../../services/jwt.service';
import { OidcClientService } from '../oidc-client.service';
import { OidcClientShowComponent, toLocalDateTime } from './oidc-client-show.component';

const secret = (id: string, expiresAt: string | null = null) => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt,
  lastUsedAt: null,
});

const client = (secrets = [secret('s1')]) => ({
  id: 'c7d1',
  name: 'Portal',
  redirectUris: ['https://portal.example/cb'],
  profile: 'secure' as const,
  scopes: [{ scope: 'pid', presentationConfigId: 'pid' }],
  secrets,
  subject: null,
  claimsFrom: null,
  issuer: 'https://eudiplo.example/verifiers/root/oidc',
});

async function render(
  service: Partial<OidcClientService>,
  roles: string[] = ['presentation:manage']
) {
  const open = vi.fn();
  const snackBar = { open: vi.fn() };
  const navigate = vi.fn();
  await TestBed.configureTestingModule({
    imports: [OidcClientShowComponent],
    providers: [
      provideRouter([]),
      { provide: OidcClientService, useValue: service },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c7d1' }) } },
      },
      { provide: MatDialog, useValue: { open } },
      { provide: MatSnackBar, useValue: snackBar },
      { provide: JwtService, useValue: { hasRole: (role: string) => roles.includes(role) } },
    ],
  }).compileComponents();
  TestBed.inject(Router).navigate = navigate;
  const fixture = TestBed.createComponent(OidcClientShowComponent);
  fixture.detectChanges();
  await vi.waitFor(() =>
    expect(fixture.componentInstance.client ?? fixture.componentInstance.loadError).toBeTruthy()
  );
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, open, snackBar, navigate };
}

describe('OidcClientShowComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('shows the settings an application needs', async () => {
    const { fixture } = await render({ getById: vi.fn().mockResolvedValue(client()) });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('c7d1');
    expect(text).toContain(
      'https://eudiplo.example/verifiers/root/oidc/.well-known/openid-configuration'
    );
    expect(text).toContain('https://portal.example/cb');
    expect(text).toContain('New for every sign-in');
  });

  it('names the client in the header with its profile, scopes and secrets', async () => {
    const { fixture } = await render({ getById: vi.fn().mockResolvedValue(client()) });
    const page = fixture.nativeElement as HTMLElement;

    expect(page.querySelector('.hero h1')?.textContent).toContain('Portal');
    expect(
      [...page.querySelectorAll('.hero-meta .badge')].map((b) => b.textContent?.trim())
    ).toEqual(['Secure (PAR required)', '1 scope', '1 secret']);
    expect(page.querySelector('a.back-link')?.getAttribute('aria-label')).toBe(
      'Back to OIDC Clients'
    );
  });

  it('shows the back link while the client loads', async () => {
    TestBed.configureTestingModule({
      imports: [OidcClientShowComponent],
      providers: [
        provideRouter([]),
        { provide: OidcClientService, useValue: { getById: () => new Promise(() => undefined) } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c7d1' }) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(OidcClientShowComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    expect(page.querySelector('a.back-link')).not.toBeNull();
    expect(page.querySelector('[aria-label="Loading OIDC client"]')).not.toBeNull();
  });

  it('says why the client could not be loaded, and retries', async () => {
    const getById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found' })
      .mockResolvedValueOnce(client());
    const { component } = await render({ getById });

    expect(component.loadError).toBe('Failed to load OIDC client: Not found');
    component.load();
    await vi.waitFor(() => expect(component.client?.id).toBe('c7d1'));
  });

  it('adds a secret and shows it once', async () => {
    const addSecret = vi.fn().mockResolvedValue({ ...secret('s2'), clientSecret: 'n3w' });
    const { component, open } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      addSecret,
    });

    component.addSecret();

    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(open).toHaveBeenCalledWith(OidcClientSecretDialogComponent, {
      data: { clientId: 'c7d1', clientSecret: 'n3w', issuer: client().issuer },
      disableClose: true,
    });
    expect(component.client?.secrets.map(({ id }) => id)).toEqual(['s1', 's2']);
    expect(component.client?.secrets[1]).not.toHaveProperty('clientSecret');
    expect(component.canAddSecret).toBe(false);

    component.addSecret();
    expect(addSecret).toHaveBeenCalledTimes(1);
  });

  it('does not delete the last secret', async () => {
    const deleteSecret = vi.fn();
    const { component } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      deleteSecret,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.deleteSecret(component.client!.secrets[0], 0);

    expect(deleteSecret).not.toHaveBeenCalled();
    expect(component.deleteSecretTooltip()).toContain('last secret');
  });

  it('deletes a secret after confirmation', async () => {
    const deleteSecret = vi.fn().mockResolvedValue(undefined);
    const { component } = await render({
      getById: vi.fn().mockResolvedValue(client([secret('s1'), secret('s2')])),
      deleteSecret,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.deleteSecret(component.client!.secrets[0], 0);

    await vi.waitFor(() => expect(component.client?.secrets.map(({ id }) => id)).toEqual(['s2']));
    expect(deleteSecret).toHaveBeenCalledWith('c7d1', 's1');
  });

  it('saves and removes the expiry of a secret', async () => {
    const setSecretExpiry = vi
      .fn()
      .mockImplementation(async (_id: string, secretId: string, expiresAt: string | null) =>
        secret(secretId, expiresAt)
      );
    const { component } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      setSecretExpiry,
    });
    const s1 = component.client!.secrets[0];
    component.expiry.get('s1')!.setValue('2099-05-01T12:30');

    component.saveExpiry(s1);

    await vi.waitFor(() => expect(component.client?.secrets[0].expiresAt).toBeTruthy());
    expect(setSecretExpiry).toHaveBeenCalledWith(
      'c7d1',
      's1',
      new Date('2099-05-01T12:30').toISOString()
    );
    expect(component.expiry.get('s1')!.value).toBe('2099-05-01T12:30');

    component.clearExpiry(component.client!.secrets[0]);
    await vi.waitFor(() => expect(component.client?.secrets[0].expiresAt).toBeNull());
    expect(setSecretExpiry).toHaveBeenLastCalledWith('c7d1', 's1', null);
  });
});

describe('OidcClientShowComponent failures and confirmations', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('deletes the client only after confirmation and returns to the list', async () => {
    const deleteClient = vi.fn().mockResolvedValue(undefined);
    const { component, navigate } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      delete: deleteClient,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    component.deleteClient();
    expect(deleteClient).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    component.deleteClient();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['../'], expect.anything()));
    expect(deleteClient).toHaveBeenCalledWith('c7d1');
  });

  it('deletes the client once while the delete runs, and not without presentation:manage', async () => {
    let finish!: () => void;
    const deleteClient = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { component, fixture, navigate } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      delete: deleteClient as never,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    component.deleteClient();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(
      page.querySelector('button[aria-label="Delete OIDC client"]')?.getAttribute('aria-disabled')
    ).toBe('true');
    component.deleteClient();
    expect(deleteClient).toHaveBeenCalledTimes(1);
    // Edit says why it waits and does not open while the delete runs.
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const edit = page.querySelector<HTMLButtonElement>('button[aria-label="Edit OIDC client"]')!;
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    edit.click();
    expect(navigateByUrl).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    await vi.waitFor(() => expect(component.deleting).toBe(false));

    TestBed.resetTestingModule();
    const denied = vi.fn();
    const other = await render(
      { getById: vi.fn().mockResolvedValue(client()), delete: denied },
      []
    );
    other.component.deleteClient();
    expect(denied).not.toHaveBeenCalled();
  });

  it('says why the client could not be deleted', async () => {
    const { component, snackBar } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      delete: vi.fn().mockRejectedValue({ statusCode: 500, message: 'x' }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    component.deleteClient();

    await vi.waitFor(() =>
      expect(snackBar.open.mock.calls.at(-1)?.[0]).toBe('Failed to delete OIDC client: x')
    );
  });

  it('keeps the secrets when adding or deleting one fails', async () => {
    const { component, open } = await render({
      getById: vi.fn().mockResolvedValue(client([secret('s1'), secret('s2')])),
      addSecret: vi.fn().mockRejectedValue({ statusCode: 409, message: 'limit' }),
      deleteSecret: vi.fn().mockRejectedValue({ statusCode: 500, message: 'x' }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    component.client!.secrets = [secret('s1')];

    component.addSecret();
    await vi.waitFor(() => expect(component.addingSecret).toBe(false));
    expect(component.client?.secrets.map(({ id }) => id)).toEqual(['s1']);
    expect(open).not.toHaveBeenCalled();

    component.client!.secrets = [secret('s1'), secret('s2')];
    component.deleteSecret(component.client!.secrets[0], 0);
    await vi.waitFor(() => expect(component.busySecrets.has('s1')).toBe(false));
    expect(component.client?.secrets.map(({ id }) => id)).toEqual(['s1', 's2']);
  });

  it('sends no expiry that is not a date, or that has passed without confirmation', async () => {
    const setSecretExpiry = vi.fn();
    const { component, snackBar } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      setSecretExpiry,
    });
    const s1 = component.client!.secrets[0];

    component.expiry.get('s1')!.setValue('not a date');
    component.saveExpiry(s1);
    expect(snackBar.open.mock.calls.at(-1)?.[0]).toBe('Enter a valid date and time.');

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    component.expiry.get('s1')!.setValue('2000-01-01T00:00');
    component.saveExpiry(s1);

    expect(setSecretExpiry).not.toHaveBeenCalled();
  });

  it('lets the expiry be saved again after a failure', async () => {
    const setSecretExpiry = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 500, message: 'x' })
      .mockResolvedValueOnce(secret('s1', '2099-05-01T10:30:00.000Z'));
    const { component, snackBar } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      setSecretExpiry,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s1 = component.client!.secrets[0];
    component.expiry.get('s1')!.setValue('2099-05-01T12:30');

    component.saveExpiry(s1);
    await vi.waitFor(() => expect(component.busySecrets.has('s1')).toBe(false));
    expect(snackBar.open.mock.calls.at(-1)?.[0]).toBe('Failed to save the expiry: x');

    component.saveExpiry(s1);
    await vi.waitFor(() => expect(setSecretExpiry).toHaveBeenCalledTimes(2));
  });
});

describe('OidcClientShowComponent secret states', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('adds one secret while a request runs', async () => {
    const addSecret = vi.fn(() => new Promise(() => undefined));
    const { component } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      addSecret: addSecret as never,
    });

    component.addSecret();
    component.addSecret();

    expect(addSecret).toHaveBeenCalledTimes(1);
  });

  it('marks only a secret whose expiry has passed', async () => {
    const past = secret('old', '2000-01-01T00:00:00.000Z');
    const future = secret('new', '2999-01-01T00:00:00.000Z');
    const { component, fixture } = await render({
      getById: vi.fn().mockResolvedValue(client([past, future, secret('open')])),
    });

    expect(component.isExpired(past)).toBe(true);
    expect(component.isExpired(future)).toBe(false);
    expect(component.isExpired(secret('open'))).toBe(false);
    const headings = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.secret h3')
    ).map((h) => h.textContent?.replace(/\s+/g, ' ').trim());
    expect(headings).toEqual(['Secret 1 (expired)', 'Secret 2', 'Secret 3']);
  });

  it('sends a past expiry once the user confirms it', async () => {
    const setSecretExpiry = vi.fn().mockResolvedValue(secret('s1', '2000-01-01T00:00:00.000Z'));
    const { component } = await render({
      getById: vi.fn().mockResolvedValue(client()),
      setSecretExpiry,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    component.expiry.get('s1')!.setValue('2000-01-01T00:00');

    component.saveExpiry(component.client!.secrets[0]);

    await vi.waitFor(() =>
      expect(setSecretExpiry).toHaveBeenCalledWith(
        'c7d1',
        's1',
        new Date('2000-01-01T00:00').toISOString()
      )
    );
  });
});

describe('toLocalDateTime', () => {
  it('formats a timestamp for a datetime-local field and ignores empty values', () => {
    const iso = new Date('2099-05-01T12:30').toISOString();
    expect(toLocalDateTime(iso)).toBe('2099-05-01T12:30');
    expect(toLocalDateTime(null)).toBe('');
    expect(toLocalDateTime('nonsense')).toBe('');
  });
});
