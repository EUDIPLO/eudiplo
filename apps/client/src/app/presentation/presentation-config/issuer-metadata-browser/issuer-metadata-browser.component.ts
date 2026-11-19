import { Component, Inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { JsonPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { fromFormQueryParams } from '../../../common/return-to-form';
import { asSentence, getApiErrorMessage, getHttpErrorMessage } from '../../../utils/error-message';
import { JwtService } from '../../../services/jwt.service';
import { CredentialConfigService } from '../../../issuance/credential-config/credential-config.service';
import {
  IssuerMetadataService,
  CredentialIssuerMetadata,
  NormalizedCredential,
  NormalizedClaim,
} from './issuer-metadata.service';
import {
  isMissingIssuanceConfig,
  TenantCredentialCatalogService,
} from './tenant-credential-catalog.service';

const TENANT_CREDENTIALS_FAILURE = 'Failed to load credential configs';

/**
 * Why the tenant's credential configs could not be loaded. The issuer metadata
 * endpoint puts its reason in an OAuth-style `error_description`, which the
 * HTTP error helper does not read, so the response body is passed on as is.
 */
function tenantCredentialsErrorMessage(err: unknown): string {
  const response = err as { status?: number; error?: unknown } | null;
  if (isMissingIssuanceConfig(err)) {
    return 'This tenant has credential configs but no Issuer Settings, so its issuer metadata cannot be built. Save the Issuer Settings, then select Reload.';
  }
  // An HTTP error carries the response body; anything else is passed as is.
  const reason = typeof response?.status === 'number' ? response.error : err;
  const message =
    response?.status === 0
      ? getHttpErrorMessage(err, TENANT_CREDENTIALS_FAILURE)
      : getApiErrorMessage(reason, TENANT_CREDENTIALS_FAILURE);
  return response?.status
    ? `${asSentence(message)} Check the credential configs, then select Reload.`
    : message;
}

export interface IssuerMetadataBrowserDialogData {
  /** Pre-fill the URL field */
  initialUrl?: string;
  /**
   * Where the credentials come from: an issuer URL the user enters (default),
   * or the credential configs of the signed-in tenant on this instance.
   */
  source?: 'issuer' | 'tenant';
}

@Component({
  selector: 'app-issuer-metadata-browser',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatExpansionModule,
    MatChipsModule,
    MatCardModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    ReactiveFormsModule,
    JsonPipe,
    RouterLink,
  ],
  templateUrl: './issuer-metadata-browser.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './issuer-metadata-browser.component.scss',
})
export class IssuerMetadataBrowserComponent implements OnInit {
  urlControl = new FormControl('', [Validators.required, Validators.pattern(/^https?:\/\/.+/)]);

  loading = false;
  error: string | null = null;
  metadata: CredentialIssuerMetadata | null = null;
  credentials: NormalizedCredential[] = [];

  /** The tenant's credential configs were loaded and there are none. */
  noTenantCredentials = false;

  /** Lists the tenant's own credential configs instead of asking for an issuer URL. */
  readonly fromTenant: boolean;

  /** Whether the caller may open the page that creates a credential config. */
  readonly canCreateCredentialConfig: boolean;

  /** The create page opens in a new tab and then says to return to this one. */
  readonly createLinkQueryParams = fromFormQueryParams({});

  // Selection state: credential ID -> Set of claim paths (as JSON strings)
  selectedCredentials = new Map<string, Set<string>>();

  constructor(
    public dialogRef: MatDialogRef<IssuerMetadataBrowserComponent>,
    @Inject(MAT_DIALOG_DATA) public data: IssuerMetadataBrowserDialogData | null,
    private metadataService: IssuerMetadataService,
    private jwtService: JwtService,
    private credentialConfigService: CredentialConfigService,
    private catalog: TenantCredentialCatalogService
  ) {
    this.fromTenant = data?.source === 'tenant';
    this.canCreateCredentialConfig = jwtService.hasRole('issuance:manage');
  }

  ngOnInit(): void {
    if (this.fromTenant) {
      void this.loadTenantCredentials();
    } else if (this.data?.initialUrl) {
      this.urlControl.setValue(this.data.initialUrl);
      this.fetchMetadata();
    }
  }

  async fetchMetadata(): Promise<void> {
    if (this.urlControl.invalid) return;

    this.loading = true;
    this.error = null;
    this.metadata = null;
    this.credentials = [];
    this.selectedCredentials.clear();

    try {
      this.metadata = await this.metadataService.fetchMetadata(this.urlControl.value!);
      this.credentials = this.metadataService.normalizeCredentials(this.metadata);
    } catch (err: any) {
      console.error('Failed to fetch issuer metadata:', err);
      if (err.status === 0) {
        this.error =
          'Failed to fetch metadata through the EUDIPLO proxy. ' +
          'Check network connectivity and issuer URL, then try again.';
      } else if (err.status === 404) {
        this.error = 'Credential issuer metadata not found at the specified URL.';
      } else {
        this.error = err.message || 'Failed to fetch issuer metadata.';
      }
    } finally {
      this.loading = false;
    }
  }

  /** Loads the credential configs of the signed-in tenant from its issuer metadata. */
  async loadTenantCredentials(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.metadata = null;
    this.credentials = [];
    this.noTenantCredentials = false;
    this.selectedCredentials.clear();

    const tenantId = this.jwtService.getTenantId();
    try {
      this.credentials = await this.catalog.fetch();
      this.noTenantCredentials = this.credentials.length === 0;
    } catch (err: unknown) {
      if (tenantId && (await this.hasNoCredentialConfigs(err))) {
        // A tenant that only verifies has no issuance config, so its issuer
        // metadata cannot be built; that is not an error here.
        this.noTenantCredentials = true;
      } else {
        console.error('Failed to load credential configs:', err);
        this.error = tenantCredentialsErrorMessage(err);
      }
    } finally {
      this.loading = false;
    }
  }

  /**
   * Whether the tenant has no credential configs at all. Only a caller who
   * may list them can tell; for everyone else this is false.
   */
  private async hasNoCredentialConfigs(err: unknown): Promise<boolean> {
    if (!this.canCreateCredentialConfig) {
      // Without the role to list them, a tenant without Issuer Settings is
      // taken as one that only verifies.
      return isMissingIssuanceConfig(err);
    }
    try {
      return (await this.credentialConfigService.loadConfigurations()).length === 0;
    } catch {
      return false;
    }
  }

  // --- Selection management ---

  isCredentialSelected(credential: NormalizedCredential): boolean {
    return this.selectedCredentials.has(credential.id);
  }

  toggleCredential(credential: NormalizedCredential, selected: boolean): void {
    if (selected) {
      // Select credential with all claims by default
      const claimPaths = new Set(credential.claims.map((c) => JSON.stringify(c.path)));
      this.selectedCredentials.set(credential.id, claimPaths);
    } else {
      this.selectedCredentials.delete(credential.id);
    }
  }

  isClaimSelected(credential: NormalizedCredential, claim: NormalizedClaim): boolean {
    const selected = this.selectedCredentials.get(credential.id);
    return selected?.has(JSON.stringify(claim.path)) ?? false;
  }

  toggleClaim(credential: NormalizedCredential, claim: NormalizedClaim, selected: boolean): void {
    const claimSet = this.selectedCredentials.get(credential.id);
    if (!claimSet) return;

    const pathKey = JSON.stringify(claim.path);
    if (selected) {
      claimSet.add(pathKey);
    } else {
      claimSet.delete(pathKey);
    }
  }

  selectAllClaims(credential: NormalizedCredential): void {
    if (!this.selectedCredentials.has(credential.id)) return;
    const claimPaths = new Set(credential.claims.map((c) => JSON.stringify(c.path)));
    this.selectedCredentials.set(credential.id, claimPaths);
  }

  deselectAllClaims(credential: NormalizedCredential): void {
    if (!this.selectedCredentials.has(credential.id)) return;
    this.selectedCredentials.set(credential.id, new Set());
  }

  hasSelections(): boolean {
    return this.selectedCredentials.size > 0;
  }

  // --- DCQL generation ---

  getGeneratedDcql(): object {
    const selections = this.getSelections();
    return this.metadataService.generateDcqlQuery(selections);
  }

  private getSelections(): {
    credential: NormalizedCredential;
    selectedClaims: NormalizedClaim[];
  }[] {
    const selections: {
      credential: NormalizedCredential;
      selectedClaims: NormalizedClaim[];
    }[] = [];

    for (const [credId, claimPaths] of this.selectedCredentials) {
      const credential = this.credentials.find((c) => c.id === credId);
      if (!credential) continue;

      const selectedClaims = credential.claims.filter((claim) =>
        claimPaths.has(JSON.stringify(claim.path))
      );

      selections.push({ credential, selectedClaims });
    }

    return selections;
  }

  // --- Dialog actions ---

  close(): void {
    this.dialogRef.close();
  }

  insert(): void {
    if (!this.hasSelections()) return;
    const dcql = this.getGeneratedDcql();
    this.dialogRef.close(dcql);
  }
}
