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
import {
  IssuerMetadataService,
  CredentialIssuerMetadata,
  NormalizedCredential,
  NormalizedClaim,
} from './issuer-metadata.service';

export interface IssuerMetadataBrowserDialogData {
  /** Pre-fill the URL field */
  initialUrl?: string;
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
  ],
  providers: [IssuerMetadataService],
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

  // Selection state: credential ID -> Set of claim paths (as JSON strings)
  selectedCredentials = new Map<string, Set<string>>();

  constructor(
    public dialogRef: MatDialogRef<IssuerMetadataBrowserComponent>,
    @Inject(MAT_DIALOG_DATA) public data: IssuerMetadataBrowserDialogData | null,
    private metadataService: IssuerMetadataService
  ) {}

  ngOnInit(): void {
    if (this.data?.initialUrl) {
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
