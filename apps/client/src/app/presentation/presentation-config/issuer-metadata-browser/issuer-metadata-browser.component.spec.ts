import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../../core';
import { CredentialConfigService } from '../../../issuance/credential-config/credential-config.service';
import { JwtService } from '../../../services/jwt.service';
import {
  IssuerMetadataBrowserComponent,
  type IssuerMetadataBrowserDialogData,
} from './issuer-metadata-browser.component';

const METADATA_URL = 'https://backend.test/.well-known/openid-credential-issuer/issuers/tenant%201';

const metadata = {
  credential_issuer: 'https://backend.test/issuers/tenant 1',
  credential_endpoint: 'https://backend.test/issuers/tenant 1/vci/credential',
  credential_configurations_supported: {
    pid: {
      format: 'dc+sd-jwt',
      vct: 'https://backend.test/issuers/tenant 1/credentials-metadata/vct/pid',
      credential_metadata: {
        display: [{ name: 'PID' }],
        claims: [{ path: ['given_name'] }, { path: ['family_name'] }],
      },
    },
  },
};

const missingIssuanceConfig = {
  error: 'well_known_error',
  error_description:
    "Failed to retrieve issuer metadata for tenant tenant 1: Issuance configuration for tenant 'tenant 1' not found",
};

function createDialog(
  data: IssuerMetadataBrowserDialogData,
  {
    tenantId = 'tenant 1' as string | null,
    roles = ['issuance:manage'],
    storedConfigs = [{ id: 'pid' }] as object[] | Error,
  } = {}
) {
  const close = vi.fn();
  const loadConfigurations =
    storedConfigs instanceof Error
      ? vi.fn().mockRejectedValue(storedConfigs)
      : vi.fn().mockResolvedValue(storedConfigs);
  TestBed.configureTestingModule({
    imports: [IssuerMetadataBrowserComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MAT_DIALOG_DATA, useValue: data },
      { provide: MatDialogRef, useValue: { close } },
      { provide: ApiService, useValue: { getBaseUrl: () => 'https://backend.test' } },
      {
        provide: JwtService,
        useValue: {
          getTenantId: () => tenantId,
          hasRole: (role: string) => roles.includes(role),
        },
      },
      { provide: CredentialConfigService, useValue: { loadConfigurations } },
    ],
  });
  const fixture = TestBed.createComponent(IssuerMetadataBrowserComponent);
  return { fixture, dialog: fixture.componentInstance, close, loadConfigurations };
}

/** Lets the pending request reach the testing backend, then answers it. */
async function answer(body: object | null, init?: { status: number; statusText: string }) {
  const http = TestBed.inject(HttpTestingController);
  const request = await vi.waitFor(() => http.expectOne(METADATA_URL));
  expect(request.request.method).toBe('GET');
  expect(request.request.headers.get('Accept')).toBe('application/json');
  request.flush(body, init);
}

describe('IssuerMetadataBrowserComponent with the tenant credential configs', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it("lists the tenant's credential configs and inserts DCQL for the picked claims", async () => {
    const { fixture, dialog, close } = createDialog({ source: 'tenant' });
    fixture.detectChanges();

    await answer(metadata);
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(dialog.credentials.map((c) => c.id)).toEqual(['pid']);
    dialog.toggleCredential(dialog.credentials[0], true);
    dialog.toggleClaim(dialog.credentials[0], dialog.credentials[0].claims[1], false);
    dialog.insert();

    expect(close).toHaveBeenCalledWith({
      credentials: [
        expect.objectContaining({
          format: 'dc+sd-jwt',
          meta: { vct_values: [metadata.credential_configurations_supported.pid.vct] },
          claims: [expect.objectContaining({ path: ['given_name'] })],
        }),
      ],
    });
  });

  it('hides the issuer URL field', async () => {
    const { fixture } = createDialog({ source: 'tenant' });
    fixture.detectChanges();
    await answer(metadata);

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('input')).toBeNull();
    expect(element.textContent).toContain('Import from Credential Config');

    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    fixture.detectChanges();
    expect(element.querySelector('.issuer-info-card')).toBeNull();
    expect(element.querySelector('code.config-id')?.textContent?.trim()).toBe('pid');
  });

  it('says when the tenant has no credential configs and links to create one', async () => {
    const { fixture, dialog } = createDialog({ source: 'tenant' });
    fixture.detectChanges();
    await answer({ ...metadata, credential_configurations_supported: {} });
    await vi.waitFor(() => expect(dialog.noTenantCredentials).toBe(true));
    fixture.detectChanges();

    const link = (fixture.nativeElement as HTMLElement).querySelector('a');
    expect(link?.getAttribute('href')).toBe('/credential-config/create?from=form');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('offers no create link to a caller who cannot create credential configs', async () => {
    const { fixture, dialog } = createDialog({ source: 'tenant' }, { roles: [] });
    fixture.detectChanges();
    await answer({ ...metadata, credential_configurations_supported: {} });
    await vi.waitFor(() => expect(dialog.noTenantCredentials).toBe(true));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('a')).toBeNull();
  });

  it("shows the backend's reason when a credential config cannot be published", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, dialog } = createDialog({ source: 'tenant' });
    fixture.detectChanges();

    await answer(
      {
        error: 'well_known_error',
        error_description:
          'Failed to retrieve issuer metadata for tenant tenant 1: SD-JWT credential configuration pid missing required vct',
      },
      { status: 500, statusText: 'Internal Server Error' }
    );
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(dialog.error).toBe(
      'Failed to retrieve issuer metadata for tenant tenant 1: SD-JWT credential configuration pid missing required vct. Check the credential configs, then select Reload.'
    );
    expect(dialog.noTenantCredentials).toBe(false);
  });

  it('shows the empty state for a tenant that only verifies', async () => {
    const { fixture, dialog } = createDialog({ source: 'tenant' }, { storedConfigs: [] });
    fixture.detectChanges();

    await answer(
      {
        error: 'well_known_error',
        error_description:
          "Failed to retrieve issuer metadata for tenant tenant 1: Issuance configuration for tenant 'tenant 1' not found",
      },
      { status: 500, statusText: 'Internal Server Error' }
    );
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(dialog.error).toBeNull();
    expect(dialog.noTenantCredentials).toBe(true);
  });

  it('shows the metadata error when the credential configs cannot be listed either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, dialog } = createDialog(
      { source: 'tenant' },
      { storedConfigs: new Error('list failed') }
    );
    fixture.detectChanges();

    await answer(
      { error: 'well_known_error', error_description: 'Failed to retrieve issuer metadata' },
      { status: 500, statusText: 'Internal Server Error' }
    );
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(dialog.noTenantCredentials).toBe(false);
    expect(dialog.error).toContain('Failed to retrieve issuer metadata');
  });

  it('shows the empty state to a verifier without Issuer Settings who cannot list credential configs', async () => {
    const { fixture, dialog, loadConfigurations } = createDialog(
      { source: 'tenant' },
      { roles: ['presentation:manage'] }
    );
    fixture.detectChanges();

    await answer(missingIssuanceConfig, { status: 500, statusText: 'Internal Server Error' });
    await vi.waitFor(() => expect(dialog.loading).toBe(false));
    fixture.detectChanges();

    expect(loadConfigurations).not.toHaveBeenCalled();
    expect(dialog.error).toBeNull();
    expect(dialog.noTenantCredentials).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Use Import from Issuer or Import from Schema'
    );
  });

  it('points to the Issuer Settings when credential configs exist without them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, dialog } = createDialog({ source: 'tenant' });
    fixture.detectChanges();

    await answer(missingIssuanceConfig, { status: 500, statusText: 'Internal Server Error' });
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(dialog.noTenantCredentials).toBe(false);
    expect(dialog.error).toBe(
      'This tenant has credential configs but no Issuer Settings, so its issuer metadata cannot be built. Save the Issuer Settings, then select Reload.'
    );
  });

  it('shows the error to a caller who cannot list credential configs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, dialog, loadConfigurations } = createDialog(
      { source: 'tenant' },
      { roles: ['presentation:manage'], storedConfigs: [] }
    );
    fixture.detectChanges();

    await answer(
      { error: 'well_known_error', error_description: 'Failed to retrieve issuer metadata' },
      { status: 500, statusText: 'Internal Server Error' }
    );
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(loadConfigurations).not.toHaveBeenCalled();
    expect(dialog.error).toContain('Failed to retrieve issuer metadata');
  });

  it('says when EUDIPLO cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, dialog } = createDialog({ source: 'tenant' }, { roles: [] });
    fixture.detectChanges();

    const http = TestBed.inject(HttpTestingController);
    const request = await vi.waitFor(() => http.expectOne(METADATA_URL));
    request.error(new ProgressEvent('error'));
    await vi.waitFor(() => expect(dialog.loading).toBe(false));

    expect(dialog.error).toBe(
      'Failed to load credential configs: the backend could not be reached. Check the connection and try again.'
    );
  });

  it('reloads after a credential config was created and drops the old selection', async () => {
    const { fixture, dialog } = createDialog({ source: 'tenant' });
    fixture.detectChanges();
    await answer({ ...metadata, credential_configurations_supported: {} });
    await vi.waitFor(() => expect(dialog.noTenantCredentials).toBe(true));

    const reload = dialog.loadTenantCredentials();
    await answer(metadata);
    await reload;
    expect(dialog.noTenantCredentials).toBe(false);
    expect(dialog.credentials.map((c) => c.id)).toEqual(['pid']);
    dialog.toggleCredential(dialog.credentials[0], true);

    const second = dialog.loadTenantCredentials();
    await answer(metadata);
    await second;
    expect(dialog.hasSelections()).toBe(false);
  });

  it('asks for nothing without a tenant', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, dialog } = createDialog({ source: 'tenant' }, { tenantId: null });
    fixture.detectChanges();

    await vi.waitFor(() => expect(dialog.loading).toBe(false));
    expect(dialog.error).toBe(
      'Failed to load credential configs: Your session has no tenant, so there are no credential configs to list.'
    );
  });
});

describe('IssuerMetadataBrowserComponent with an issuer URL', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('asks for the issuer URL and sends no request on its own', () => {
    const { fixture } = createDialog({});
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('input')).not.toBeNull();
    expect(element.textContent).toContain('Import from Issuer');
    expect(element.textContent).not.toContain('Import from Credential Config');
  });
});
