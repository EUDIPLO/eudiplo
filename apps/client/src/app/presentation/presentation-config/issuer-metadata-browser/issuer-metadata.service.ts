import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core';

/**
 * OID4VCI Credential Issuer Metadata structure
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-11.2.2
 */
export interface CredentialIssuerMetadata {
  credential_issuer: string;
  credential_endpoint: string;
  authorization_servers?: string[];
  batch_credential_endpoint?: string;
  deferred_credential_endpoint?: string;
  notification_endpoint?: string;
  credential_response_encryption?: {
    alg_values_supported: string[];
    enc_values_supported: string[];
    encryption_required: boolean;
  };
  credential_identifiers_supported?: boolean;
  signed_metadata?: string;
  display?: DisplayInfo[];
  credential_configurations_supported: Record<string, CredentialConfiguration>;
}

interface DisplayInfo {
  name?: string;
  locale?: string;
  logo?: { uri?: string; alt_text?: string };
  description?: string;
  background_color?: string;
  text_color?: string;
}

export interface CredentialConfiguration {
  format: string;
  scope?: string;
  cryptographic_binding_methods_supported?: string[];
  credential_signing_alg_values_supported?: string[];
  proof_types_supported?: Record<string, { proof_signing_alg_values_supported: string[] }>;
  display?: DisplayInfo[];
  // SD-JWT VC specific
  vct?: string;
  claims?: Record<string, ClaimDefinition>;
  // mso_mdoc specific
  doctype?: string;
  claims_namespaced?: Record<string, Record<string, ClaimDefinition>>;
  // OID4VCI Draft 15+ structure with credential_metadata
  credential_metadata?: {
    display?: DisplayInfo[];
    claims?: ClaimMetadataItem[];
  };
}

/**
 * Claim metadata item as defined in OID4VCI Draft 15+
 * Claims are represented as an array with path arrays
 */
interface ClaimMetadataItem {
  path: string[];
  mandatory?: boolean;
  value_type?: string;
  display?: { name?: string; locale?: string }[];
}

export interface ClaimDefinition {
  mandatory?: boolean;
  value_type?: string;
  display?: { name?: string; locale?: string }[];
  nested?: Record<string, ClaimDefinition>;
}

/**
 * Normalized claim for UI display
 */
export interface NormalizedClaim {
  path: string[];
  displayName: string;
  mandatory: boolean;
  valueType?: string;
  namespace?: string; // For mso_mdoc
}

/**
 * Normalized credential for UI display
 */
export interface NormalizedCredential {
  id: string;
  format: string;
  displayName: string;
  description?: string;
  vct?: string;
  doctype?: string;
  claims: NormalizedClaim[];
  logo?: { uri?: string; alt_text?: string };
  backgroundColor?: string;
  textColor?: string;
}

/**
 * A claim path as text: `nationalities[*]` for every element of an array,
 * `places[0].city` for one element.
 */
export function claimPathLabel(path: readonly (string | number | null)[]): string {
  return path.reduce<string>((label, step) => {
    if (step === null) return `${label}[*]`;
    if (typeof step === 'number') return `${label}[${step}]`;
    return label ? `${label}.${step}` : step;
  }, '');
}

/**
 * The array a claim is requested as, when its path addresses every element
 * of one (see {@link wholeClaimPaths}); `null` when it is requested as it is.
 */
export function requestedArrayLabel(claim: NormalizedClaim): string | null {
  const steps: readonly (string | null)[] = claim.path;
  const everyElement = steps.indexOf(null);
  return everyElement > 0 ? claimPathLabel(claim.path.slice(0, everyElement)) : null;
}

/**
 * The paths a generated query asks for. Issuer metadata addresses every
 * element of an array with a `null` step (`["nationalities", null]`), which
 * the query form cannot show: such a claim is requested as the array it is in
 * (`["nationalities"]`), once. So is a claim below the elements:
 * `["addresses", null, "locality"]` asks for `["addresses"]`.
 */
function wholeClaimPaths(claims: NormalizedClaim[]): string[][] {
  const paths = new Map<string, string[]>();
  for (const claim of claims) {
    const steps: readonly (string | null)[] = claim.path;
    const everyElement = steps.indexOf(null);
    const path = everyElement === -1 ? claim.path : claim.path.slice(0, everyElement);
    if (path.length) paths.set(JSON.stringify(path), path);
  }
  return [...paths.values()];
}

@Injectable({ providedIn: 'root' })
export class IssuerMetadataService {
  constructor(
    private readonly http: HttpClient,
    private readonly apiService: ApiService
  ) {}

  /**
   * Fetch credential issuer metadata from a given URL.
   * Handles both full URLs and base URLs (appending .well-known path).
   */
  async fetchMetadata(issuerUrl: string): Promise<CredentialIssuerMetadata> {
    const baseUrl = this.requireBaseUrl();

    const endpoint = `${baseUrl}/api/verifier/config/issuer-metadata/resolve`;
    return firstValueFrom(
      this.http.post<CredentialIssuerMetadata>(endpoint, {
        issuerUrl,
      })
    );
  }

  /**
   * Fetch the issuer metadata this instance publishes for a tenant, which lists
   * the tenant's own credential configs with their final vct or doctype and
   * claims. It is read straight from the instance, not through the resolve
   * proxy, which may refuse the instance's own address.
   */
  async fetchTenantMetadata(tenantId: string): Promise<CredentialIssuerMetadata> {
    const baseUrl = this.requireBaseUrl();

    const endpoint = `${baseUrl}/.well-known/openid-credential-issuer/issuers/${encodeURIComponent(tenantId)}`;
    return await firstValueFrom(
      this.http.get<CredentialIssuerMetadata>(endpoint, {
        headers: { Accept: 'application/json' },
      })
    );
  }

  private requireBaseUrl(): string {
    const baseUrl = this.apiService.getBaseUrl();
    if (!baseUrl) {
      throw new Error('API base URL is not configured. Please log in again.');
    }
    return baseUrl;
  }

  /**
   * Normalize credential configurations into a UI-friendly format
   */
  normalizeCredentials(metadata: CredentialIssuerMetadata): NormalizedCredential[] {
    const credentials: NormalizedCredential[] = [];

    for (const [id, config] of Object.entries(metadata.credential_configurations_supported)) {
      // Display can be in config.display or config.credential_metadata.display
      const display = config.display?.[0] || config.credential_metadata?.display?.[0];
      const credential: NormalizedCredential = {
        id,
        format: config.format,
        displayName: display?.name || id,
        description: display?.description,
        vct: config.vct,
        doctype: config.doctype,
        claims: this.extractClaims(config),
        logo: display?.logo,
        backgroundColor: display?.background_color,
        textColor: display?.text_color,
      };
      credentials.push(credential);
    }

    return credentials;
  }

  /**
   * Extract claims from a credential configuration.
   * Supports multiple formats:
   * - OID4VCI Draft 15+: credential_metadata.claims as array with path
   * - Legacy: config.claims as nested object
   * - mso_mdoc: config.claims_namespaced
   */
  private extractClaims(config: CredentialConfiguration): NormalizedClaim[] {
    const claims: NormalizedClaim[] = [];

    // OID4VCI Draft 15+ format: claims as array in credential_metadata
    if (config.credential_metadata?.claims) {
      for (const claim of config.credential_metadata.claims) {
        claims.push({
          path: claim.path,
          displayName: claim.display?.[0]?.name || claimPathLabel(claim.path),
          mandatory: claim.mandatory || false,
          valueType: claim.value_type,
        });
      }
      return claims;
    }

    if (config.format === 'mso_mdoc' && config.claims_namespaced) {
      // mso_mdoc format: claims are namespaced
      for (const [namespace, namespaceClaims] of Object.entries(config.claims_namespaced)) {
        for (const [claimName, claimDef] of Object.entries(namespaceClaims)) {
          claims.push({
            path: [claimName],
            displayName: claimDef.display?.[0]?.name || claimName,
            mandatory: claimDef.mandatory || false,
            valueType: claimDef.value_type,
            namespace,
          });
        }
      }
    } else if (config.claims) {
      // Legacy SD-JWT VC format: flat or nested claims as object
      this.extractNestedClaims(config.claims, [], claims);
    }

    return claims;
  }

  /**
   * Recursively extract nested claims
   */
  private extractNestedClaims(
    claimsObj: Record<string, ClaimDefinition>,
    currentPath: string[],
    result: NormalizedClaim[]
  ): void {
    for (const [claimName, claimDef] of Object.entries(claimsObj)) {
      const path = [...currentPath, claimName];

      if (claimDef.nested) {
        // Has nested claims - recurse
        this.extractNestedClaims(claimDef.nested, path, result);
      } else {
        // Leaf claim
        result.push({
          path,
          displayName: claimDef.display?.[0]?.name || claimName,
          mandatory: claimDef.mandatory || false,
          valueType: claimDef.value_type,
        });
      }
    }
  }

  /**
   * Generate DCQL query from selected credentials and claims
   */
  generateDcqlQuery(
    selections: {
      credential: NormalizedCredential;
      selectedClaims: NormalizedClaim[];
    }[]
  ): object {
    const credentials = selections.map((selection, index) => {
      const cred: any = {
        id: selection.credential.id || `cred_${index}`,
        format: this.mapFormat(selection.credential.format),
      };

      // Add meta based on format
      if (
        selection.credential.format === 'vc+sd-jwt' ||
        selection.credential.format === 'dc+sd-jwt'
      ) {
        if (selection.credential.vct) {
          cred.meta = { vct_values: [selection.credential.vct] };
        }
      } else if (selection.credential.format === 'mso_mdoc') {
        if (selection.credential.doctype) {
          cred.meta = { doctype_value: selection.credential.doctype };
        }
      }

      // Add claims if any selected
      if (selection.selectedClaims.length > 0) {
        if (selection.credential.format === 'mso_mdoc') {
          // Group claims by namespace for mso_mdoc
          const namespaceMap = new Map<string, NormalizedClaim[]>();
          for (const claim of selection.selectedClaims) {
            const ns = claim.namespace || selection.credential.doctype || 'default';
            if (!namespaceMap.has(ns)) {
              namespaceMap.set(ns, []);
            }
            namespaceMap.get(ns)!.push(claim);
          }

          cred.claims = [];
          for (const [namespace, nsClaims] of namespaceMap) {
            for (const claim of nsClaims) {
              cred.claims.push({
                path: [namespace, claim.path[claim.path.length - 1]],
              });
            }
          }
        } else {
          // SD-JWT format uses path arrays
          // An empty claims list is not a valid query: leave the key out.
          const paths = wholeClaimPaths(selection.selectedClaims);
          if (paths.length) cred.claims = paths.map((path) => ({ path }));
        }
      }

      return cred;
    });

    return { credentials };
  }

  /**
   * Map issuer format to DCQL format
   */
  private mapFormat(format: string): string {
    switch (format) {
      case 'vc+sd-jwt':
        return 'dc+sd-jwt';
      case 'mso_mdoc':
        return 'mso_mdoc';
      default:
        return format;
    }
  }
}
