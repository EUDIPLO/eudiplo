import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, isDevMode, ChangeDetectionStrategy } from '@angular/core';
import {
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  CredentialConfig,
  TrustList,
  type SchemaMetaConfig,
  type VocabularyEntryDto,
  trustListControllerGetAllTrustLists,
} from '@eudiplo/sdk-core';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { SchemaService } from '../schema.service';

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

@Component({
  selector: 'app-schema-create',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
  ],
  templateUrl: './schema-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './schema-create.component.scss',
})
export class SchemaCreateComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  loading = false;
  readonly demoDefaultsEnabled = isDevMode();
  /** Credential config ID passed via query param — linked back to the schema metadata on submit */
  credentialConfigId: string | undefined;

  /** All credential configs (for importing schema URIs) */
  credentialConfigs: CredentialConfig[] = [];
  /** All trust lists (for importing trusted authorities) */
  trustLists: TrustList[] = [];
  /** Predefined vocabulary entries for category selection */
  categoryVocabularies: VocabularyEntryDto[] = [];
  /** Predefined vocabulary entries for tag selection */
  tagVocabularies: VocabularyEntryDto[] = [];

  readonly attestationLoSOptions = [
    { value: 'iso_18045_high', label: 'High (ISO 18045)' },
    { value: 'iso_18045_moderate', label: 'Moderate (ISO 18045)' },
    { value: 'iso_18045_enhanced-basic', label: 'Enhanced Basic (ISO 18045)' },
    { value: 'iso_18045_basic', label: 'Basic (ISO 18045)' },
  ];

  readonly bindingTypeOptions = [
    { value: 'claim', label: 'Claim' },
    { value: 'key', label: 'Key' },
    { value: 'biometric', label: 'Biometric' },
    { value: 'none', label: 'None' },
  ];

  readonly frameworkTypeOptions = [
    { value: 'etsi_tl', label: 'ETSI TL' },
    { value: 'openid_federation', label: 'OpenID Federation' },
    { value: 'x509', label: 'X.509 Root Certificate' },
  ];

  readonly schemaFormatOptions = [
    { value: 'dc+sd-jwt', label: 'dc+sd-jwt' },
    { value: 'mso_mdoc', label: 'mso_mdoc' },
  ];

  /** The main schema metadata composition form */
  composeForm = new FormGroup({
    version: new FormControl('', [Validators.required, Validators.pattern(SEMVER_REGEX)]),
    rulebookURI: new FormControl('', [Validators.required]),
    attestationLoS: new FormControl('', [Validators.required]),
    bindingType: new FormControl('', [Validators.required]),
    name: new FormControl('', [Validators.required]),
    category: new FormControl(''),
    tags: new FormControl<string[]>([]),
    schemaURIs: new FormArray<FormGroup>([], Validators.required),
    trustedAuthorities: new FormArray<FormGroup>([], Validators.required),
  });

  /** For selecting a config whose schemaURIs to import */
  importSchemaConfigIds = new FormControl<string[]>([]);
  /** For selecting trust lists to include as trusted authorities */
  importTrustListIds = new FormControl<string[]>([]);

  constructor(
    private readonly fb: FormBuilder,
    private readonly schemaService: SchemaService,
    private readonly credentialConfigService: CredentialConfigService,
    private readonly snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.credentialConfigId =
      this.route.snapshot.queryParamMap.get('credentialConfigId') ?? undefined;
    this.loadData();
    if (this.demoDefaultsEnabled) {
      this.applyDemoValues();
    }
  }

  applyDemoValues(): void {
    this.composeForm.patchValue({
      name: 'German PID',
      version: '1.0.0',
      rulebookURI:
        'https://raw.githubusercontent.com/cre8/catalog-of-attestations/refs/heads/main/rulebooks/gym-membership-card/1.0.0.md',
      attestationLoS: 'iso_18045_basic',
      bindingType: 'key',
    });

    // schemaURIs are imported from credential configs only.
    this.schemaURIs.clear();
    this.importSchemaConfigIds.setValue([]);

    this.trustedAuthorities.clear();
    this.importTrustListIds.setValue([]);
  }

  get schemaURIs(): FormArray<FormGroup> {
    return this.composeForm.get('schemaURIs') as FormArray<FormGroup>;
  }

  get trustedAuthorities(): FormArray<FormGroup> {
    return this.composeForm.get('trustedAuthorities') as FormArray<FormGroup>;
  }

  /** Display label for a credential config (used in select dropdown). */
  configLabel(c: CredentialConfig): string {
    return c.description ? `${c.description} (${c.id})` : c.id;
  }

  /** Display label for a trust list (used in select dropdown). */
  trustListLabel(tl: TrustList): string {
    return tl.description ? `${tl.description} (${tl.id})` : tl.id;
  }

  vocabularyLabel(entry: VocabularyEntryDto): string {
    if (entry.status === 'deprecated' && entry.replacedBy) {
      return `${entry.label} (${entry.code}) - deprecated, use ${entry.replacedBy}`;
    }
    if (entry.status === 'deprecated') {
      return `${entry.label} (${entry.code}) - deprecated`;
    }
    return `${entry.label} (${entry.code})`;
  }

  private createSchemaURIGroup(
    format = '',
    uri = '',
    imported = false,
    credentialConfigId = ''
  ): FormGroup {
    const group = this.fb.group({
      format: [format, Validators.required],
      uri: [uri, Validators.required],
      credentialConfigId: [credentialConfigId],
      imported: [imported],
    });
    if (imported) {
      group.get('format')!.disable();
      group.get('uri')!.disable();
    }
    return group;
  }

  private createTrustedAuthorityGroup(
    frameworkType = '',
    value = '',
    isLoTE = false,
    verificationMethod = '',
    imported = false
  ): FormGroup {
    const group = this.fb.group({
      frameworkType: [frameworkType, Validators.required],
      value: [value, Validators.required],
      isLoTE: [isLoTE],
      verificationMethod: [verificationMethod],
      imported: [imported],
    });
    if (imported) {
      group.get('frameworkType')!.disable();
      group.get('value')!.disable();
    }
    return group;
  }
  private createTrustListGroup(trustListId: string, label: string, isLoTE = true): FormGroup {
    return this.fb.group({
      trustListId: [trustListId],
      label: [label],
      isLoTE: [isLoTE],
      imported: [true],
    });
  }

  addX509TrustAnchor(): void {
    this.trustedAuthorities.push(this.createTrustedAuthorityGroup('x509', '', false, '', false));
  }

  removeTrustedAuthority(index: number): void {
    this.trustedAuthorities.removeAt(index);
  }

  syncSchemaURIsFromSelection(): void {
    const selectedIds = this.importSchemaConfigIds.value ?? [];
    this.schemaURIs.clear();

    for (const id of selectedIds) {
      const config = this.credentialConfigs.find((c) => c.id === id);
      if (!config) continue;

      const format = config.config?.format ?? '';
      const uri = typeof config.vct === 'string' ? config.vct : (config.config?.docType ?? '');
      this.schemaURIs.push(this.createSchemaURIGroup(format, uri, true, id));
    }
  }

  syncTrustedAuthoritiesFromSelection(): void {
    const selectedIds = this.importTrustListIds.value ?? [];

    const existingLoTE = new Map<string, boolean>();
    for (const group of this.trustedAuthorities.controls) {
      const trustListId = group.get('trustListId')?.value as string | undefined;
      const isLoTE = group.get('isLoTE')?.value as boolean | undefined;
      if (trustListId) {
        existingLoTE.set(trustListId, isLoTE ?? true);
      }
    }

    const directAuthorities = this.trustedAuthorities.controls
      .filter((group) => !group.get('trustListId')?.value)
      .map((group) => group.getRawValue());

    this.trustedAuthorities.clear();
    for (const id of selectedIds) {
      const tl = this.trustLists.find((t) => t.id === id);
      if (!tl) continue;

      const label = tl.description ? `${tl.description} (${tl.id})` : tl.id;
      const isLoTE = existingLoTE.get(id) ?? true;
      this.trustedAuthorities.push(this.createTrustListGroup(id, label, isLoTE));
    }

    for (const authority of directAuthorities) {
      this.trustedAuthorities.push(
        this.createTrustedAuthorityGroup(
          authority['frameworkType'] ?? 'x509',
          authority['value'] ?? '',
          authority['isLoTE'] ?? false,
          authority['verificationMethod'] ?? '',
          false
        )
      );
    }
  }

  async loadData(): Promise<void> {
    try {
      const [configs, tlResponse, vocabularies] = await Promise.all([
        this.credentialConfigService.loadConfigurations(),
        trustListControllerGetAllTrustLists(),
        this.schemaService.getVocabularies(),
      ]);
      this.credentialConfigs = configs;
      this.trustLists = Array.isArray(tlResponse.data) ? tlResponse.data : [];
      this.categoryVocabularies = Array.isArray(vocabularies?.categories)
        ? vocabularies.categories
        : [];
      this.tagVocabularies = Array.isArray(vocabularies?.tags) ? vocabularies.tags : [];

      // Auto-select linked credential config when provided via query param.
      if (this.credentialConfigId && configs.some((c) => c.id === this.credentialConfigId)) {
        this.importSchemaConfigIds.setValue([this.credentialConfigId]);
      }

      this.syncSchemaURIsFromSelection();
      this.syncTrustedAuthoritiesFromSelection();
    } catch {
      // non-fatal — selects will simply be empty
    }
  }

  /**
   * Build a thin form payload. Backend resolves and validates schema metadata
   * internals (schema URI metadata, trust authority parsing, integrity assets).
   */
  private buildConfigFromForm(): Record<string, unknown> {
    const raw = this.composeForm.getRawValue();

    return {
      version: raw.version!,
      rulebookURI: raw.rulebookURI!,
      attestationLoS: raw.attestationLoS,
      bindingType: raw.bindingType,
      ...(raw.name ? { name: raw.name } : {}),
      ...(raw.category ? { category: raw.category } : {}),
      ...(Array.isArray(raw.tags) && raw.tags.length > 0 ? { tags: raw.tags } : {}),
      // Send credential config references so backend can resolve schema URI metadata.
      schemaURIs: (raw.schemaURIs as Record<string, unknown>[]).map((e) => {
        return {
          credentialConfigId: e['credentialConfigId'],
          format: e['format'],
          uri: e['uri'],
        };
      }),
      trustedAuthorities: (raw.trustedAuthorities as Record<string, unknown>[]).map((e) => ({
        ...(e['trustListId'] ? { trustListId: e['trustListId'] } : {}),
        ...(e['frameworkType'] ? { frameworkType: e['frameworkType'] } : {}),
        ...(e['value'] ? { value: String(e['value']).replace(/\s/g, '') } : {}),
        ...(e['verificationMethod'] ? { verificationMethod: e['verificationMethod'] } : {}),
      })),
    };
  }

  private resolveLinkedCredentialConfigId(): string | undefined {
    if (this.credentialConfigId) {
      return this.credentialConfigId;
    }

    const selectedIds = this.importSchemaConfigIds.value ?? [];
    return selectedIds.length === 1 ? selectedIds[0] : undefined;
  }

  get linkedCredentialConfig(): CredentialConfig | undefined {
    const linkedCredentialConfigId = this.resolveLinkedCredentialConfigId();
    if (!linkedCredentialConfigId) {
      return undefined;
    }

    return this.credentialConfigs.find((config) => config.id === linkedCredentialConfigId);
  }

  get linkedSchemaMetadataId(): string | null {
    const schemaMetadataId = (this.linkedCredentialConfig as any)?.schemaMeta?.id;
    return typeof schemaMetadataId === 'string' && schemaMetadataId.trim().length > 0
      ? schemaMetadataId
      : null;
  }

  get linkedSchemaMetadataRouteId(): string | null {
    if (!this.linkedSchemaMetadataId) {
      return null;
    }

    const segments = this.linkedSchemaMetadataId.split('/').filter(Boolean);
    return segments.at(-1) ?? this.linkedSchemaMetadataId;
  }

  get hasLinkedSchemaMetadataConflict(): boolean {
    return !!this.resolveLinkedCredentialConfigId() && !!this.linkedSchemaMetadataId;
  }

  async submit(): Promise<void> {
    if (this.composeForm.invalid) {
      this.composeForm.markAllAsTouched();
      return;
    }

    if (this.hasLinkedSchemaMetadataConflict) {
      this.snackBar.open(
        'The selected credential config already has a linked schema. Open the existing schema or unlink it first.',
        'Close',
        { duration: 5000 }
      );
      return;
    }

    this.loading = true;
    try {
      // The backend reserves the attestation id, signs the config and submits
      // it to the registrar in a single call — we just receive the resulting
      // metadata entry.
      const created = await this.schemaService.publishSchemaMetadata(
        // Version, LoS and binding type are required controls of the form.
        this.buildConfigFromForm() as Omit<SchemaMetaConfig, 'id'>,
        undefined,
        this.resolveLinkedCredentialConfigId()
      );

      this.snackBar.open('Schema submitted', 'Close', { duration: 3000 });
      this.router.navigate(['/schema', created.id]);
    } catch (error) {
      console.error('Failed to submit schema metadata:', error);
      const msg = error instanceof Error ? error.message : 'Failed to submit schema';
      this.snackBar.open(msg, 'Close', { duration: 5000 });
    } finally {
      this.loading = false;
    }
  }
}
