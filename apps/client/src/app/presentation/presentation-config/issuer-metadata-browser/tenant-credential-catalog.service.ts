import { Injectable, inject } from '@angular/core';
import { JwtService } from '../../../services/jwt.service';
import { IssuerMetadataService, NormalizedCredential } from './issuer-metadata.service';

/**
 * Whether the tenant's issuer metadata does not exist because the tenant has
 * no Issuer Settings, as for a tenant that only verifies. Newer backends
 * answer 404; older ones answer 500 with the `IssuanceConfigurationNotFound`
 * text in `error_description`.
 */
export function isMissingIssuanceConfig(err: unknown): boolean {
  const response = err as { status?: number; error?: { error_description?: unknown } } | null;
  if (response?.status === 404) return true;
  const description = response?.error?.error_description;
  return (
    typeof description === 'string' &&
    /Issuance configuration for tenant .* not found/.test(description)
  );
}

/**
 * The credential configs this tenant issues, read from its published issuer
 * metadata: for Import from Credential Config and for hints in the
 * verification query builder.
 */
@Injectable({ providedIn: 'root' })
export class TenantCredentialCatalogService {
  private readonly metadataService = inject(IssuerMetadataService);
  private readonly jwtService = inject(JwtService);

  /** The tenant's credential configs; throws when there is no tenant or the request fails. */
  async fetch(): Promise<NormalizedCredential[]> {
    const tenantId = this.jwtService.getTenantId();
    if (!tenantId) {
      throw new Error('Your session has no tenant, so there are no credential configs to list.');
    }
    const metadata = await this.metadataService.fetchTenantMetadata(tenantId);
    return this.metadataService.normalizeCredentials(metadata);
  }

  /**
   * The same for optional hints: an empty list instead of an error. A tenant
   * that does not issue is expected; other failures are logged.
   */
  async load(): Promise<NormalizedCredential[]> {
    if (!this.jwtService.getTenantId()) return [];
    try {
      return await this.fetch();
    } catch (error) {
      if (!isMissingIssuanceConfig(error)) {
        console.warn('Credential config hints are unavailable:', error);
      }
      return [];
    }
  }
}
