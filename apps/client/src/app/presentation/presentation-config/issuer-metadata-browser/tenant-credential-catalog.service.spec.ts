import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '../../../services/jwt.service';
import { IssuerMetadataService } from './issuer-metadata.service';
import { TenantCredentialCatalogService } from './tenant-credential-catalog.service';

const metadata = {
  credential_issuer: 'https://backend.test/issuers/t',
  credential_endpoint: 'https://backend.test/issuers/t/vci/credential',
  credential_configurations_supported: {
    pid: { format: 'dc+sd-jwt', vct: 'urn:pid', credential_metadata: { claims: [] } },
  },
};

function catalog(tenantId: string | null, fetchTenantMetadata: ReturnType<typeof vi.fn>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: JwtService, useValue: { getTenantId: () => tenantId } },
      {
        provide: IssuerMetadataService,
        useValue: {
          fetchTenantMetadata,
          normalizeCredentials: (m: typeof metadata) =>
            new IssuerMetadataService(null as never, null as never).normalizeCredentials(m),
        },
      },
    ],
  });
  return TestBed.inject(TenantCredentialCatalogService);
}

describe('TenantCredentialCatalogService', () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the tenant's credential configs from its issuer metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(metadata);
    const credentials = await catalog('t', fetch).load();

    expect(fetch).toHaveBeenCalledWith('t');
    expect(credentials.map((c) => [c.id, c.vct])).toEqual([['pid', 'urn:pid']]);
  });

  it('asks for nothing without a tenant', async () => {
    const fetch = vi.fn();
    const service = catalog(null, fetch);
    expect(await service.load()).toEqual([]);
    await expect(service.fetch()).rejects.toThrow('no tenant');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a 500 naming the missing issuance config',
      new HttpErrorResponse({
        status: 500,
        error: {
          error: 'well_known_error',
          error_description:
            "Failed to retrieve issuer metadata for tenant t: Issuance configuration for tenant 't' not found",
        },
      }),
    ],
    ['a 404', new HttpErrorResponse({ status: 404 })],
  ])('gives no hints, quietly, for a tenant that does not issue (%s)', async (_name, error) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn().mockRejectedValue(error);

    expect(await catalog('t', fetch).load()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives no hints but logs any other failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 500 }));

    const service = catalog('t', fetch);
    expect(await service.load()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    await expect(service.fetch()).rejects.toBeInstanceOf(HttpErrorResponse);
  });
});
