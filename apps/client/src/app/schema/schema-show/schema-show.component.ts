import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type {
  CredentialConfig,
  PublishSchemaMetaConfig,
  SchemaMetaConfig,
  UpdateSchemaMetadataDto,
  VocabularyEntryDto,
} from '@eudiplo/sdk-core';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { JwtService } from '../../services/jwt.service';
import { SchemaMetadata, SchemaService } from '../schema.service';
import { LabelledFailure, getApiErrorMessage } from '../../utils/error-message';
import { SourceLoadState, loadSource, reportSourceFailures } from '../../common/load-source';
import { SEMVER_REGEX, compareVersionsDesc, proposeNextVersion } from '../schema-version';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { copyToClipboard } from '../../utils/copy-to-clipboard';

function formatNotCarriedOver(values: string[]): string {
  return `Not in the registrar vocabulary, so not carried over: ${values.join(', ')}.`;
}

@Component({
  selector: 'app-schema-show',
  imports: [
    CommonModule,
    DatePipe,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
  ],
  templateUrl: './schema-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './schema-show.component.scss',
})
export class SchemaShowComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly schemaService = inject(SchemaService);
  private readonly credentialConfigService = inject(CredentialConfigService);
  private readonly jwtService = inject(JwtService);
  private readonly snackBar = inject(MatSnackBar);

  id = '';
  item?: SchemaMetadata;
  availableVersions: string[] = [];
  loading = false;
  /** Why the schema itself could not be loaded; shown in place of the details. */
  loadError = '';
  /** Version requested by the last load, for Retry. */
  private requestedVersion?: string;
  /** Counts loads, so a slower earlier load cannot overwrite a later one. */
  private loadRun = 0;
  /**
   * Load state of the sources besides the schema itself. Each loads on its
   * own, so a registrar without vocabularies or a missing role only disables
   * what depends on that source. They belong to the tenant, not to a version,
   * so they load once per page and not on every version switch.
   */
  readonly loadState: Record<'vocabularies' | 'credentialConfigs', SourceLoadState> = {
    vocabularies: 'loading',
    credentialConfigs: 'loading',
  };
  /** The running or settled load of the sources: the failure of each, undefined for one that loaded. */
  private sources?: Promise<(LabelledFailure | undefined)[]>;
  /** Whether the failures of `sources` were named already, so they show once. */
  private sourceFailuresShown = false;
  showPublishForm = false;
  publishing = false;
  deprecating = false;
  deleting = false;
  saving = false;

  /** Predefined vocabulary entries for category selection */
  categoryVocabularies: VocabularyEntryDto[] = [];
  /** Predefined vocabulary entries for tag selection */
  tagVocabularies: VocabularyEntryDto[] = [];

  /** All credential configs of the tenant */
  private credentialConfigs: CredentialConfig[] = [];
  /** Credential configs that reference this schema metadata via schemaMeta.id */
  relatedCredentialConfigs: CredentialConfig[] = [];

  /**
   * For each trusted authority whose value is a local trust-list URL,
   * the extracted UUID — used to build the /trust-list/:id router link.
   */
  trustListIds: { value: string; localId: string | null }[] = [];

  metadataForm = new FormGroup({
    displayName: new FormControl(''),
    category: new FormControl(''),
    tags: new FormControl<string[]>([]),
  });

  publishForm = new FormGroup({
    newVersion: new FormControl('', [
      Validators.required,
      Validators.pattern(SEMVER_REGEX),
      (control) => (this.availableVersions.includes(control.value) ? { taken: true } : null),
    ]),
    rulebookURI: new FormControl(''),
    deprecateCurrent: new FormControl(true),
  });

  get displayName(): string {
    const displayName = (this.item as { displayName?: string } | undefined)?.displayName;
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      return displayName;
    }

    return this.item?.id ?? this.id;
  }

  ngOnInit(): void {
    combineLatest([this.route.paramMap, this.route.queryParamMap])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([paramMap, queryParams]) => {
        this.id = paramMap.get('id') || '';
        const version = queryParams.get('version') || undefined;
        void this.load(version);
      });
  }

  /**
   * Publishing a version (and listing the credential configs it is rebuilt
   * from) needs `issuance:manage`; the schema pages themselves only need
   * `registrar:manage`.
   */
  get canManageIssuance(): boolean {
    return this.jwtService.hasRole('issuance:manage');
  }

  /** Trust lists need `issuance:manage` or `presentation:manage`. */
  get canOpenTrustLists(): boolean {
    return this.jwtService.hasRole(['issuance:manage', 'presentation:manage']);
  }

  async load(version?: string): Promise<void> {
    if (!this.id) return;
    const run = ++this.loadRun;
    const isCurrent = () => run === this.loadRun;
    this.loading = true;
    this.loadError = '';
    this.requestedVersion = version;
    this.sources ??= this.loadSources();
    try {
      const [latestItem, versions] = await Promise.all([
        this.schemaService.getById(this.id),
        this.schemaService.getVersions(this.id),
      ]);

      const selectedVersion = version?.trim();
      const item = selectedVersion
        ? ((
            await this.schemaService.list({ attestationId: this.id, version: selectedVersion })
          )[0] ?? latestItem)
        : latestItem;
      // Fast version switching: only the latest load updates the page.
      if (!isCurrent()) return;

      this.availableVersions = versions.map((entry) => entry.version).sort(compareVersionsDesc);
      this.item = item;
      this.relatedCredentialConfigs = this.findRelatedCredentialConfigs(item);

      if (selectedVersion && item.version !== selectedVersion) {
        this.snackBar.open(
          `Version ${selectedVersion} not found. Showing version ${item.version} instead.`,
          'Close',
          { duration: 4000 }
        );
      }

      this.metadataForm.patchValue({
        displayName: (item as { displayName?: string }).displayName || '',
        category: item.category || '',
        tags: (item.tags ?? []) as string[],
      });
      this.metadataForm.markAsPristine();
      this.publishForm.patchValue({
        // Proposed from the newest version, so it does not collide with an existing one.
        newVersion: proposeNextVersion(this.availableVersions[0] ?? item.version),
        rulebookURI: item.rulebookURI || '',
      });
      // Map trusted authority values to local trust-list IDs (last URL segment)
      this.trustListIds = (item.trustedAuthorities ?? []).map((ta) => ({
        value: ta.value,
        localId: this.extractTrustListId(ta.value),
      }));
    } catch (error) {
      console.error('Failed to load schema metadata:', error);
      if (!isCurrent()) return;
      this.item = undefined;
      this.loadError = getApiErrorMessage(error, 'Failed to load schema');
    } finally {
      if (isCurrent()) {
        this.loading = false;
      }
    }

    if (isCurrent()) {
      await this.showSourceFailures();
    }
  }

  retryLoad(): void {
    // Retry also loads the sources that failed with the schema.
    if (Object.values(this.loadState).includes('failed')) {
      this.sources = this.loadSources(true);
      this.sourceFailuresShown = false;
    }
    void this.load(this.requestedVersion);
  }

  /** Loads the sources that failed again, for the Retry buttons next to their messages. */
  async retrySources(): Promise<void> {
    this.sources = this.loadSources(true);
    this.sourceFailuresShown = false;
    await this.showSourceFailures();
  }

  private loadSources(onlyFailed = false): Promise<(LabelledFailure | undefined)[]> {
    const load = (source: keyof SchemaShowComponent['loadState']) =>
      !onlyFailed || this.loadState[source] === 'failed';
    return Promise.all([
      load('credentialConfigs') ? this.loadCredentialConfigs() : undefined,
      load('vocabularies') ? this.loadVocabularies() : undefined,
    ]);
  }

  /**
   * Names the sources that failed, once per load of them. Without the schema,
   * the error card replaces the page and they are not reported on top.
   */
  private async showSourceFailures(): Promise<void> {
    const failures = (await this.sources) ?? [];
    if (!this.item || this.sourceFailuresShown) return;
    this.sourceFailuresShown = true;
    reportSourceFailures(this.snackBar, failures);
  }

  /**
   * Loads the category and tag vocabularies. Category and Tags stay disabled
   * until they are loaded: without the vocabulary the selects have no options.
   */
  private loadVocabularies(): Promise<LabelledFailure | undefined> {
    const { category, tags } = this.metadataForm.controls;
    category.disable();
    tags.disable();
    return loadSource(this.loadState, 'vocabularies', 'the registrar vocabulary', async () => {
      const vocabularies = await this.schemaService.getVocabularies();
      this.categoryVocabularies = vocabularies.categories;
      this.tagVocabularies = vocabularies.tags;
      category.enable();
      tags.enable();
    });
  }

  private async loadCredentialConfigs(): Promise<LabelledFailure | undefined> {
    if (!this.canManageIssuance) {
      this.credentialConfigs = [];
      return undefined;
    }
    return loadSource(this.loadState, 'credentialConfigs', 'credential configs', async () => {
      this.credentialConfigs = await this.credentialConfigService.loadConfigurations();
      this.relatedCredentialConfigs = this.item ? this.findRelatedCredentialConfigs(this.item) : [];
    });
  }

  private findRelatedCredentialConfigs(item: SchemaMetadata): CredentialConfig[] {
    return this.credentialConfigs.filter((c) => {
      const schemaMetaId = (c.schemaMeta as SchemaMetaConfig | undefined)?.id;
      const schemaMetaIdMatches =
        !!schemaMetaId && (schemaMetaId === item.id || schemaMetaId.split('/').pop() === item.id);

      // Fallback for entries where schemaMeta.id was not written back:
      // infer relation via schema URI path segment /schema/{credentialConfigId}/{format}.
      const schemaUriMatches = (item.schemaURIs ?? []).some(
        (entry) => typeof entry.uri === 'string' && entry.uri.includes(`/schema/${c.id}/`)
      );

      return schemaMetaIdMatches || schemaUriMatches;
    });
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

  async saveMetadata(): Promise<void> {
    if (!this.item || this.saving) return;
    const entry = this.item;
    this.saving = true;
    try {
      // Only the fields the user changed are sent: a category or tag outside
      // the registrar vocabulary has no option in the selects, and sending it
      // back unchanged would fail validation.
      const { displayName, category, tags } = this.metadataForm.controls;
      const updated = await this.schemaService.updateMetadata(entry.id, entry.version, {
        ...(displayName.dirty ? { displayName: displayName.value?.trim() || undefined } : {}),
        ...(category.dirty
          ? { category: (category.value || undefined) as UpdateSchemaMetadataDto['category'] }
          : {}),
        ...(tags.dirty ? { tags: (tags.value ?? []) as UpdateSchemaMetadataDto['tags'] } : {}),
      });

      this.snackBar.open(`Metadata of version ${entry.version} updated`, 'Close', {
        duration: 3000,
      });
      // Another version may have been opened meanwhile; its form stays as it is.
      if (this.item === entry) {
        this.item = updated;
        this.metadataForm.markAsPristine();
      }
    } catch (error) {
      console.error('Failed to update metadata:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to update metadata'));
    } finally {
      this.saving = false;
    }
  }

  async copyJwt(): Promise<void> {
    if (!this.id) return;
    let jwt: string;
    try {
      jwt = await this.schemaService.getSignedJwt(this.id, this.item?.version ?? '');
    } catch (error) {
      console.error('Failed to load JWT:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to load the signed JWT'));
      return;
    }
    await copyToClipboard(
      this.snackBar,
      jwt,
      'Signed JWT copied to clipboard',
      'Could not copy the signed JWT. Use Download export to save it instead.'
    );
  }

  get jwtUrl(): string {
    const version = this.item?.version;
    const idUrl = this.extractCatalogIdFromSignedJwt(this.item?.signedJwt);
    if (!idUrl || !version) return '';

    // If the ID already points to a versioned JWT endpoint, keep it as-is.
    if (/\/versions\/[^/]+\/jwt$/.test(idUrl)) {
      return idUrl;
    }

    return `${idUrl}/versions/${version}/jwt`;
  }

  private extractCatalogIdFromSignedJwt(jwt?: string): string | null {
    if (!jwt) return null;
    try {
      const parts = jwt.split('.');
      if (parts.length < 2) return null;

      const payloadBase64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
      const padded = payloadBase64.padEnd(
        payloadBase64.length + ((4 - (payloadBase64.length % 4)) % 4),
        '='
      );
      const payloadJson = atob(padded);
      const payload = JSON.parse(payloadJson) as { id?: unknown };
      const idUrl = typeof payload.id === 'string' ? payload.id.replace(/\/$/, '') : '';
      return idUrl || null;
    } catch {
      return null;
    }
  }

  async copyJwtUrl(): Promise<void> {
    if (!this.jwtUrl) return;
    await copyToClipboard(
      this.snackBar,
      this.jwtUrl,
      'JWT URL copied to clipboard',
      'Could not copy the JWT URL. Select it in the JWT URL field and copy it by hand.'
    );
  }

  async downloadExport(): Promise<void> {
    if (!this.id) return;
    try {
      const jwt = await this.schemaService.getSignedJwt(this.id, this.item?.version ?? '');
      const blob = new Blob([jwt], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `schema-metadata-${this.id}-${this.item?.version ?? 'latest'}.jwt`;
      a.click();
      URL.revokeObjectURL(url);
      this.snackBar.open('Signed JWT downloaded', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Failed to download JWT:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to download JWT'));
    }
  }

  /**
   * Extract the UUID at the end of a trust-list URL
   * (e.g. http://host/issuers/tenant/trust-list/<uuid> → <uuid>).
   * Returns null if the value does not look like a local trust-list URL.
   */
  private extractTrustListId(value: string): string | null {
    try {
      const url = new URL(value);
      const segments = url.pathname.split('/').filter(Boolean);
      const idx = segments.indexOf('trust-list');
      if (idx !== -1 && segments[idx + 1]) {
        return segments[idx + 1];
      }
    } catch {
      // not a URL
    }
    return null;
  }

  private deriveSchemaUriMetadata(config: CredentialConfig): Record<string, unknown> {
    const format = config.config?.format;
    if (format === 'dc+sd-jwt') {
      const vct =
        typeof config.vct === 'string'
          ? config.vct
          : config.vct &&
              typeof config.vct === 'object' &&
              'vct' in config.vct &&
              typeof (config.vct as { vct?: unknown }).vct === 'string'
            ? (config.vct as { vct: string }).vct
            : undefined;

      if (!vct) {
        throw new Error(
          `Credential config ${config.id}: missing vct required for schemaURIs metadata`
        );
      }
      return { vct };
    }

    if (format === 'mso_mdoc') {
      const docType =
        config.config?.docType ||
        ((config.config as { doctype?: string } | undefined)?.doctype ?? undefined);

      if (!docType) {
        throw new Error(
          `Credential config ${config.id}: missing docType required for schemaURIs metadata`
        );
      }
      return { doctype_value: docType };
    }

    return {};
  }

  /**
   * The linked credential config a schema URI was built from. URIs that
   * EUDIPLO served before 4.3.0 name it (`/schema/{credentialConfigId}/{format}`);
   * the registrar stores uploaded schemas under random file names, so other
   * URIs match the only linked credential config with their format.
   */
  private findRelatedCredentialConfigForSchemaUri(
    uri: string | undefined,
    format: string
  ): CredentialConfig | undefined {
    const named = uri
      ? this.relatedCredentialConfigs.find((cfg) => uri.includes(`/schema/${cfg.id}/`))
      : undefined;
    if (named) return named;

    const sameFormat = this.relatedCredentialConfigs.filter((cfg) => cfg.config?.format === format);
    return sameFormat.length === 1 ? sameFormat[0] : undefined;
  }

  togglePublishForm(): void {
    // The header button stays focusable without the role, to show why it is disabled.
    if (!this.showPublishForm && !this.canManageIssuance) return;
    this.showPublishForm = !this.showPublishForm;
  }

  /**
   * Why Publish is unavailable while the credential configs the new version
   * is rebuilt from are loading or failed to load.
   */
  get publishBlockedReason(): string {
    if (!this.canManageIssuance) {
      return 'Publishing a new version needs the issuance:manage role.';
    }
    if (this.loadState.credentialConfigs === 'failed') {
      return 'Publishing needs the credential configs, which could not be loaded.';
    }
    if (
      this.loadState.credentialConfigs === 'loading' ||
      this.loadState.vocabularies === 'loading'
    ) {
      return 'Loading credential configs and the registrar vocabulary…';
    }
    const unmatched = (this.item?.schemaURIs ?? []).find(
      (s) => !this.findRelatedCredentialConfigForSchemaUri(s.uri, s.formatIdentifier)
    );
    if (unmatched) {
      return (
        `Publishing needs exactly one credential config of format ${unmatched.formatIdentifier} ` +
        'linked to this schema, to rebuild its schema URI.'
      );
    }
    return '';
  }

  async publishNewVersion(): Promise<void> {
    if (!this.item || this.publishForm.invalid || this.publishBlockedReason) return;

    const newVersion = this.publishForm.get('newVersion')!.value!;
    const rulebookURI = this.publishForm.get('rulebookURI')!.value || this.item.rulebookURI;
    const deprecateCurrent = this.publishForm.get('deprecateCurrent')!.value;
    const catalogId = this.extractCatalogIdFromSignedJwt(this.item.signedJwt);

    if (!catalogId) {
      this.snackBar.open(
        'Cannot publish new version: invalid catalog ID in signed JWT payload',
        'Close',
        {
          duration: 4000,
        }
      );
      return;
    }

    const current = this.item;
    this.publishing = true;
    try {
      const { category, tags, notCarriedOver } = this.knownClassification(current);
      const config: PublishSchemaMetaConfig = {
        id: catalogId,
        // The registrar does not copy the display name, category or tags to a
        // new version, so they are sent again. The name is required; entries
        // without a display name keep showing their ID.
        name: this.displayName,
        version: newVersion,
        rulebookURI: rulebookURI ?? undefined,
        attestationLoS: current.attestationLoS,
        bindingType: current.bindingType,
        ...(category ? { category } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        schemaURIs: (current.schemaURIs ?? []).map((s) => ({
          format: s.formatIdentifier,
          uri: s.uri,
          meta: this.deriveSchemaUriMetadata(
            (() => {
              const cfg = this.findRelatedCredentialConfigForSchemaUri(s.uri, s.formatIdentifier);
              if (!cfg) {
                throw new Error(
                  `Unable to derive schemaURIs metadata for ${s.uri ?? 'unknown URI'}: ` +
                    `link exactly one credential config of format ${s.formatIdentifier} to this schema.`
                );
              }
              return cfg;
            })()
          ),
        })),
        trustedAuthorities: (current.trustedAuthorities ?? []).map((t) => ({
          frameworkType: t.frameworkType,
          value: t.value,
        })),
      };

      const newEntry = await this.schemaService.publishSchemaMetadataVersion(config);

      const notes: string[] = [];
      if (notCarriedOver.length > 0) {
        notes.push(formatNotCarriedOver(notCarriedOver));
      }
      // The new version is already published, so a failed deprecation is
      // reported with the result instead of failing the publish.
      const deprecationError = deprecateCurrent
        ? (await this.markDeprecated(current, newVersion)).error
        : undefined;
      if (deprecationError) {
        notes.push(`${deprecationError}.`);
      }

      const message = [`Version ${newVersion} published successfully.`, ...notes].join(' ');
      if (deprecationError) {
        this.offerDeprecationRetry(message, current, newVersion);
      } else {
        this.snackBar.open(message, 'Close', { duration: notes.length > 0 ? 10000 : 4000 });
      }
      // The user may have left the page while the publish was running.
      if (this.destroyRef.destroyed) return;
      this.showPublishForm = false;
      this.router.navigate(['/schema', newEntry.id], {
        queryParams: { version: newEntry.version },
      });
    } catch (error) {
      console.error('Failed to publish new version:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to publish new version'));
    } finally {
      this.publishing = false;
    }
  }

  /**
   * Says which category and tag values of the shown version a new version
   * leaves out, or that they could not be checked against the vocabulary.
   */
  get classificationNote(): string {
    if (!this.item || this.loadState.vocabularies === 'loading') return '';
    const { category, tags, notCarriedOver, checked } = this.knownClassification(this.item);
    if (!checked) {
      const values = [...(category ? [category] : []), ...tags];
      return values.length > 0
        ? `The category and tags could not be checked against the registrar vocabulary and are carried over unchecked: ${values.join(', ')}.`
        : '';
    }
    return notCarriedOver.length > 0 ? formatNotCarriedOver(notCarriedOver) : '';
  }

  /**
   * Category and tags of an entry that the registrar vocabulary lists. The
   * registrar returns tags as free-form strings, but a publish request with a
   * value outside the vocabulary fails with 400, so such values are left out
   * and reported. Deprecated codes are carried over: they stay valid, the forms
   * only stop offering them for new selections. Without a loaded vocabulary
   * every value is carried over unchecked (`checked: false`); the backend still
   * rejects unknown ones and names them.
   */
  private knownClassification(entry: SchemaMetadata): {
    category?: PublishSchemaMetaConfig['category'];
    tags: NonNullable<PublishSchemaMetaConfig['tags']>;
    notCarriedOver: string[];
    checked: boolean;
  } {
    if (this.loadState.vocabularies !== 'loaded') {
      return {
        category: (entry.category || undefined) as PublishSchemaMetaConfig['category'],
        tags: (entry.tags ?? []) as NonNullable<PublishSchemaMetaConfig['tags']>,
        notCarriedOver: [],
        checked: false,
      };
    }

    const categoryCodes = new Set(this.categoryVocabularies.map((v) => v.code));
    const tagCodes = new Set(this.tagVocabularies.map((v) => v.code));
    const notCarriedOver: string[] = [];

    let category: PublishSchemaMetaConfig['category'];
    if (entry.category && categoryCodes.has(entry.category)) {
      category = entry.category;
    } else if (entry.category) {
      notCarriedOver.push(entry.category);
    }

    const tags: string[] = [];
    for (const tag of entry.tags ?? []) {
      if (tagCodes.has(tag)) {
        tags.push(tag);
      } else {
        notCarriedOver.push(tag);
      }
    }

    return {
      category,
      tags: tags as NonNullable<PublishSchemaMetaConfig['tags']>,
      notCarriedOver,
      checked: true,
    };
  }

  /**
   * Deprecates a version at the registrar, naming `successor` as the version
   * that supersedes it. Returns the updated entry, or the error message.
   */
  private async markDeprecated(
    entry: SchemaMetadata,
    successor?: string
  ): Promise<{ updated?: SchemaMetadata; error?: string }> {
    try {
      const updated = await this.schemaService.deprecateVersion(entry.id, entry.version, {
        deprecated: true,
        ...(successor
          ? { message: `Superseded by version ${successor}`, supersededByVersion: successor }
          : {}),
      });
      return { updated };
    } catch (error) {
      console.error(`Failed to deprecate version ${entry.version}:`, error);
      return { error: getApiErrorMessage(error, `Failed to deprecate version ${entry.version}`) };
    }
  }

  /**
   * Shows the publish result with a Retry action for the failed deprecation
   * of the superseded version. A retry that fails again offers Retry again.
   */
  private offerDeprecationRetry(message: string, entry: SchemaMetadata, newVersion: string): void {
    this.snackBar
      .open(`${message} Retry now, or later with Deprecate on version ${entry.version}.`, 'Retry', {
        duration: 15000,
      })
      .onAction()
      .subscribe(() => void this.retryDeprecation(entry, newVersion));
  }

  private async retryDeprecation(entry: SchemaMetadata, newVersion: string): Promise<void> {
    const { error } = await this.markDeprecated(entry, newVersion);
    if (error) {
      this.offerDeprecationRetry(`${error}.`, entry, newVersion);
      return;
    }
    this.snackBar.open(`Version ${entry.version} deprecated.`, 'Close', { duration: 4000 });
  }

  /** The newest version above `version`, which supersedes it. */
  private newestVersionAbove(version: string): string | undefined {
    const newest = this.availableVersions[0];
    return newest && compareVersionsDesc(newest, version) < 0 ? newest : undefined;
  }

  /**
   * Deprecates the shown version, for example when the automatic deprecation
   * after publishing failed or was unticked. A newer version, if any, is named
   * as its successor.
   */
  async deprecate(): Promise<void> {
    if (!this.item || this.item.deprecated || this.deprecating) return;
    const entry = this.item;
    const successor = this.newestVersionAbove(entry.version);
    const question = [
      `Deprecate version ${entry.version} of schema "${this.displayName}" at the registrar?`,
      successor
        ? `It will be marked as superseded by version ${successor}.`
        : 'It is the newest version, so no version replaces it.',
      'The Web Client cannot undo this.',
    ].join(' ');
    if (!confirm(question)) return;

    this.deprecating = true;
    const { updated, error } = await this.markDeprecated(entry, successor);
    this.deprecating = false;
    if (error) {
      openErrorSnackBar(this.snackBar, error);
      return;
    }
    this.snackBar.open(`Version ${entry.version} deprecated`, 'Close', { duration: 3000 });
    // Show the new state unless another version was opened meanwhile.
    if (updated && this.item === entry) {
      this.item = updated;
    }
  }

  async delete(): Promise<void> {
    if (!this.item || this.deleting) return;
    const entry = this.item;
    const question = [
      `Delete version ${entry.version} of schema "${this.displayName}" at the registrar?`,
      ...(this.availableVersions.length === 1 ? [this.lastVersionReferencesNote()] : []),
      'This cannot be undone.',
    ]
      .filter(Boolean)
      .join(' ');
    if (!confirm(question)) return;

    this.deleting = true;
    try {
      await this.schemaService.delete(entry.id, entry.version);
      this.snackBar.open(`Version ${entry.version} deleted`, 'Close', { duration: 3000 });
      // The user may have left the page while the request was running.
      if (!this.destroyRef.destroyed) {
        this.router.navigate(['/schema']);
      }
    } catch (error) {
      console.error('Failed to delete schema metadata:', error);
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, `Failed to delete version ${entry.version}`)
      );
    } finally {
      this.deleting = false;
    }
  }

  /** Names the credential configs that would point to a deleted schema, or says they are unknown. */
  private lastVersionReferencesNote(): string {
    if (!this.canManageIssuance || this.loadState.credentialConfigs !== 'loaded') {
      return 'It is the only version; credential configs may still reference the schema.';
    }
    if (this.relatedCredentialConfigs.length === 0) return '';
    return (
      'It is the only version, and these credential configs still reference the schema: ' +
      `${this.relatedCredentialConfigs.map((c) => c.description || c.id).join(', ')}.`
    );
  }

  async showVersion(version: string): Promise<void> {
    if (!version || this.item?.version === version) return;

    await this.router.navigate(['/schema', this.id], {
      queryParams: { version },
    });
  }
}
