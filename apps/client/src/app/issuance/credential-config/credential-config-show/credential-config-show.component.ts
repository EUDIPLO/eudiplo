import { Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Clipboard, ClipboardModule } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  type ClaimFieldDefinition,
  CredentialConfig,
  deriveRuntimeArtifacts,
  flattenFields,
} from '@eudiplo/sdk-core';
import { CredentialConfigService } from '../credential-config.service';
import { StatusListManagementService } from '../../../status-list-management/status-list-management.service';
import { ConfigDocumentService } from '../../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { JwtService } from '../../../services/jwt.service';
import { getApiErrorMessage } from '../../../utils/error-message';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { LoadErrorComponent } from '../../../common/load-error.component';

interface ClaimFieldRow {
  key: string;
  hasDefaultValue: boolean;
  defaultValue?: unknown;
  disclosableLabel: 'Yes' | 'No' | 'N/A' | 'Not configured';
  mandatory: boolean | null;
  typeLabel: string | null;
  displayLabels: string[];
  /** JSON Schema keywords the field adds on top of its type; only fields define them. */
  constraints?: Record<string, unknown>;
}

interface SchemaPathInfo {
  required: Set<string>;
  known: Set<string>;
  types: Map<string, string>;
}

@Component({
  selector: 'app-credential-config-show',
  imports: [
    CommonModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatTooltipModule,
    MatExpansionModule,
    MatChipsModule,
    MatDividerModule,
    MatListModule,
    MatTabsModule,
    FlexLayoutModule,
    RouterModule,
    ClipboardModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './credential-config-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './credential-config-show.component.scss',
})
export class CredentialConfigShowComponent implements OnInit {
  config: CredentialConfig | undefined;
  /** Set when the page's data could not be loaded, so the page is not left blank. */
  loadError = '';
  statusListId: string | undefined;

  constructor(
    private readonly credentialConfigService: CredentialConfigService,
    private readonly statusListService: StatusListManagementService,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly clipboard: Clipboard,
    private readonly jwtService: JwtService,
    private readonly configDocuments: ConfigDocumentService
  ) {}

  /** The schema pages need `registrar:manage`; without it their links would end in "Access denied". */
  get canOpenSchemas(): boolean {
    return this.jwtService.hasRole('registrar:manage');
  }

  get isMdocFormat(): boolean {
    return this.config?.config?.format === 'mso_mdoc';
  }

  get isVctString(): boolean {
    return typeof this.config?.vct === 'string';
  }

  get vctAsString(): string | null {
    return typeof this.config?.vct === 'string' ? this.config.vct : null;
  }

  get vctAsObject(): any {
    return typeof this.config?.vct === 'object' ? this.config.vct : null;
  }

  get formatLabel(): string {
    if (this.config?.config?.format === 'mso_mdoc') {
      return 'mDOC (mso_mdoc)';
    }
    return 'SD-JWT VC (dc+sd-jwt)';
  }

  get primaryDisplay(): any {
    return this.config?.config?.display?.[0];
  }

  get schemaMetadataId(): string | null {
    const id = (this.config as any)?.schemaMeta?.id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
  }

  get schemaMetadataRouteId(): string | null {
    if (!this.schemaMetadataId) {
      return null;
    }

    const segments = this.schemaMetadataId.split('/').filter(Boolean);
    return segments.at(-1) ?? this.schemaMetadataId;
  }

  get fields(): Record<string, unknown>[] {
    const value = (this.config as any)?.fields;
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  }

  /**
   * Every field, nested children included, with child paths resolved to full
   * claim paths. Unlike the derived claims metadata, each entry keeps the
   * field's type, default value and constraints.
   */
  private get flattenedFields(): ClaimFieldDefinition[] {
    return flattenFields(this.fields as unknown as ClaimFieldDefinition[]).filter(
      (field) => Array.isArray(field.path) && field.path.length > 0
    );
  }

  get runtimeArtifacts(): {
    claims: Record<string, unknown>;
    disclosureFrame?: Record<string, unknown>;
    claimsMetadata: Record<string, unknown>[];
    schema: Record<string, unknown>;
    claimsByNamespace: Record<string, Record<string, unknown>>;
  } {
    return deriveRuntimeArtifacts(this.fields as any) as any;
  }

  /**
   * Entries of the Claims Metadata card: the flattened field definitions when
   * the configuration has `fields` (so type, default value and constraints
   * show), otherwise the configured `claimsMetadata`.
   */
  get claimsMetadataEntries(): Record<string, unknown>[] {
    if (this.fields.length > 0) {
      return this.flattenedFields as unknown as Record<string, unknown>[];
    }

    const value = (this.config?.config as any)?.claimsMetadata;
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  }

  get claimsByNamespaceValue(): Record<string, unknown> | null {
    if (this.fields.length > 0) {
      const value = this.runtimeArtifacts.claimsByNamespace;
      return Object.keys(value).length > 0 ? value : null;
    }

    const value = (this.config?.config as any)?.claimsByNamespace;
    return value && typeof value === 'object' ? value : null;
  }

  get schemaValue(): Record<string, unknown> | null {
    if (this.fields.length > 0) {
      return this.runtimeArtifacts.schema;
    }

    const value = (this.config as any)?.schema;
    return value && typeof value === 'object' ? value : null;
  }

  get defaultNamespaceValue(): string | null {
    const namespaces = this.claimsByNamespaceValue ? Object.keys(this.claimsByNamespaceValue) : [];
    if (namespaces.length === 1) {
      return namespaces[0];
    }
    return null;
  }

  get showJsonSchemaSection(): boolean {
    if (!this.schemaValue) {
      return false;
    }

    if (this.claimFieldRows.length === 0) {
      return true;
    }

    return !this.claimFieldRows.every((row) => this.isRowComplete(row));
  }

  copyToClipboard(value: string, label: string): void {
    this.clipboard.copy(value);
    this.snackBar.open(`${label} copied to clipboard`, 'Close', {
      duration: 2000,
    });
  }

  ngOnInit(): void {
    this.loadConfig();
  }

  loadConfig(): void {
    const configId = this.route.snapshot.paramMap.get('id');
    if (configId) {
      this.loadError = '';
      this.credentialConfigService.getConfig(configId).then(
        (config) => {
          this.config = config;
          if (config.statusManagement) {
            this.loadStatusListId(config.id);
          }
        },
        (error) => {
          console.error('Load error:', error);
          this.loadError = getApiErrorMessage(error, 'Failed to load credential configuration');
        }
      );
    }
  }

  private async loadStatusListId(credentialConfigId: string): Promise<void> {
    try {
      const lists = await this.statusListService.getLists();
      const match =
        lists.find((l) => l.credentialConfigurationId === credentialConfigId) ||
        lists.find((l) => !l.credentialConfigurationId);
      this.statusListId = match?.id;
    } catch (error) {
      console.error('Failed to load status list:', error);
    }
  }

  deleteConfig() {
    if (
      this.config &&
      confirm(`Delete credential configuration "${this.config.id}"? This cannot be undone.`)
    ) {
      this.credentialConfigService
        .deleteConfiguration(this.config.id)
        .then(() => {
          this.snackBar.open('Configuration deleted successfully', 'Close', {
            duration: 3000,
          });
          this.router.navigate(['../'], { relativeTo: this.route });
        })
        .catch((error) => {
          openErrorSnackBar(
            this.snackBar,
            getApiErrorMessage(error, 'Failed to delete configuration')
          );
          console.error('Delete error:', error);
        });
    }
  }

  unlinkSchemaMetadata(): void {
    if (!this.config?.id || !this.schemaMetadataId) {
      return;
    }

    if (!confirm(`Unlink schema '${this.schemaMetadataId}' from this credential configuration?`)) {
      return;
    }

    this.credentialConfigService
      .updateConfiguration(this.config.id, { schemaMeta: null } as any)
      .then(() => {
        if (this.config) {
          this.config = {
            ...this.config,
            schemaMeta: undefined,
          };
        }

        this.snackBar.open('Schema link removed', 'Close', {
          duration: 3000,
        });
      })
      .catch((error) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to remove schema link'));
        console.error('Unlink schema error:', error);
      });
  }

  formatLifetime(seconds?: number | null): string {
    if (!seconds) return 'Not set';

    const days = Math.floor(seconds / (24 * 3600));
    const hours = Math.floor((seconds % (24 * 3600)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      return `${seconds} second${seconds > 1 ? 's' : ''}`;
    }
  }

  /** The claim's JSON Schema constraints, or null when it defines none. */
  constraintsOf(claim: object): Record<string, unknown> | null {
    const value = (claim as Record<string, unknown>)['constraints'];
    return value && typeof value === 'object' && Object.keys(value).length > 0
      ? (value as Record<string, unknown>)
      : null;
  }

  getObjectKeys(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  formatJsonValue(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value, null, 2);
  }

  get claimFieldRows(): ClaimFieldRow[] {
    if (!this.config) {
      return [];
    }

    if (this.fields.length > 0) {
      return this.flattenedFields
        .map((field) => {
          const hasDefaultValue = Object.prototype.hasOwnProperty.call(field, 'defaultValue');
          return {
            key: this.pathToKey(field.path),
            hasDefaultValue,
            defaultValue: hasDefaultValue ? field.defaultValue : undefined,
            disclosableLabel: this.isMdocFormat
              ? 'N/A'
              : field.disclosable === true
                ? 'Yes'
                : field.disclosable === false
                  ? 'No'
                  : 'Not configured',
            mandatory: typeof field.mandatory === 'boolean' ? field.mandatory : null,
            typeLabel: typeof field.type === 'string' ? field.type : null,
            displayLabels: this.getDisplayLabels(field.display),
            constraints: this.constraintsOf(field) ?? undefined,
          } as ClaimFieldRow;
        })
        .sort((a, b) => a.key.localeCompare(b.key));
    }

    const defaults = new Map<string, unknown>();
    for (const item of this.flattenObjectLeaves((this.config as any).claims)) {
      defaults.set(this.pathToKey(item.path), item.value);
    }

    const disclosurePaths = this.collectDisclosurePaths((this.config as any).disclosureFrame);
    const hasDisclosureConfig = disclosurePaths.size > 0;
    const schemaPathInfo = this.collectSchemaPathInfo((this.config as any).schema);

    const rows = new Map<string, ClaimFieldRow>();
    const metadataClaims = this.claimsMetadataEntries;

    for (const claim of metadataClaims) {
      const path = Array.isArray(claim['path']) ? claim['path'] : [];
      const key = this.pathToKey(path);
      const defaultValue = defaults.get(key);
      const disclosableFromMetadata =
        typeof claim['disclosable'] === 'boolean' ? claim['disclosable'] : undefined;

      const schemaType = schemaPathInfo.types.get(key) ?? null;
      rows.set(key, {
        key,
        hasDefaultValue: defaults.has(key),
        defaultValue,
        disclosableLabel: this.resolveDisclosableLabel(
          key,
          hasDisclosureConfig,
          disclosurePaths,
          disclosableFromMetadata
        ),
        mandatory: this.resolveMandatory(
          key,
          typeof claim['mandatory'] === 'boolean' ? claim['mandatory'] : undefined,
          schemaPathInfo
        ),
        typeLabel:
          typeof claim['type'] === 'string'
            ? claim['type']
            : typeof claim['valueType'] === 'string'
              ? claim['valueType']
              : typeof claim['value_type'] === 'string'
                ? claim['value_type']
                : schemaType,
        displayLabels: this.getDisplayLabels(claim['display']),
      });
    }

    for (const [key, defaultValue] of defaults.entries()) {
      if (rows.has(key)) {
        continue;
      }
      const schemaType = schemaPathInfo.types.get(key) ?? null;
      rows.set(key, {
        key,
        hasDefaultValue: true,
        defaultValue,
        disclosableLabel: this.resolveDisclosableLabel(
          key,
          hasDisclosureConfig,
          disclosurePaths,
          undefined
        ),
        mandatory: this.resolveMandatory(key, undefined, schemaPathInfo),
        typeLabel: schemaType ?? this.inferTypeFromValue(defaultValue),
        displayLabels: [],
      });
    }

    return Array.from(rows.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  private getDisplayLabels(display: unknown): string[] {
    if (!Array.isArray(display)) {
      return [];
    }

    return display
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const locale =
          typeof record['locale'] === 'string' ? (record['locale'] as string) : 'default';
        const name = typeof record['name'] === 'string' ? (record['name'] as string) : null;

        return name ? `${locale}: ${name}` : null;
      })
      .filter((value): value is string => value !== null);
  }

  private resolveDisclosableLabel(
    key: string,
    hasDisclosureConfig: boolean,
    disclosurePaths: Set<string>,
    disclosableFromMetadata?: boolean
  ): 'Yes' | 'No' | 'N/A' | 'Not configured' {
    if (this.isMdocFormat) {
      return 'N/A';
    }

    if (typeof disclosableFromMetadata === 'boolean') {
      return disclosableFromMetadata ? 'Yes' : 'No';
    }

    if (!hasDisclosureConfig) {
      return 'Not configured';
    }

    for (const disclosurePath of disclosurePaths) {
      if (
        this.isPrefixPathMatch(disclosurePath, key) ||
        this.isPrefixPathMatch(key, disclosurePath)
      ) {
        return 'Yes';
      }
    }

    return 'No';
  }

  private collectDisclosurePaths(
    frame: unknown,
    basePath: (string | number | null)[] = []
  ): Set<string> {
    const paths = new Set<string>();
    if (!frame || typeof frame !== 'object') {
      return paths;
    }

    const record = frame as Record<string, unknown>;

    // SD-JWT disclosure frame marks disclosable claims via _sd arrays.
    if (Array.isArray(record['_sd'])) {
      for (const claimName of record['_sd']) {
        if (typeof claimName === 'string' && claimName.length > 0) {
          paths.add(this.pathToKey([...basePath, claimName]));
        }
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key === '_sd' || key.startsWith('_')) {
        continue;
      }

      if (value === true) {
        paths.add(this.pathToKey([...basePath, key]));
        continue;
      }

      const nested = this.collectDisclosurePaths(value, [...basePath, key]);
      for (const nestedPath of nested) {
        paths.add(nestedPath);
      }
    }

    return paths;
  }

  private isPrefixPathMatch(prefixPath: string, candidatePath: string): boolean {
    const prefix = prefixPath.split('.');
    const candidate = candidatePath.split('.');

    if (prefix.length > candidate.length) {
      return false;
    }

    for (let i = 0; i < prefix.length; i += 1) {
      if (prefix[i] === '*') {
        continue;
      }
      if (prefix[i] !== candidate[i]) {
        return false;
      }
    }

    return true;
  }

  private resolveMandatory(
    key: string,
    mandatoryFromMetadata: boolean | undefined,
    schemaPathInfo: SchemaPathInfo
  ): boolean | null {
    if (typeof mandatoryFromMetadata === 'boolean') {
      return mandatoryFromMetadata;
    }

    if (schemaPathInfo.required.has(key)) {
      return true;
    }

    if (schemaPathInfo.known.has(key)) {
      return false;
    }

    return null;
  }

  private collectSchemaPathInfo(schema: unknown): SchemaPathInfo {
    const required = new Set<string>();
    const known = new Set<string>();
    const types = new Map<string, string>();

    const walk = (
      node: unknown,
      path: (string | number | null)[] = [],
      parentRequired = false
    ): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      const record = node as Record<string, unknown>;
      const type = record['type'];

      if (type === 'array' || record['items']) {
        const arrayPath = [...path, null];
        const arrayKey = this.pathToKey(arrayPath);
        known.add(arrayKey);
        types.set(arrayKey, 'array');
        if (parentRequired) {
          required.add(arrayKey);
        }
        walk(record['items'], arrayPath, parentRequired);
      }

      const properties =
        record['properties'] && typeof record['properties'] === 'object'
          ? (record['properties'] as Record<string, unknown>)
          : undefined;
      const requiredProps = Array.isArray(record['required'])
        ? new Set(
            (record['required'] as unknown[]).filter(
              (value): value is string => typeof value === 'string'
            )
          )
        : new Set<string>();

      if (properties) {
        for (const [prop, child] of Object.entries(properties)) {
          const childPath = [...path, prop];
          const childKey = this.pathToKey(childPath);
          known.add(childKey);

          const childType = this.extractSchemaTypeLabel(child);
          if (childType) {
            types.set(childKey, childType);
          }

          const isRequiredHere = requiredProps.has(prop);
          if (isRequiredHere) {
            required.add(childKey);
          }

          walk(child, childPath, parentRequired && isRequiredHere);
        }
      }

      if (Array.isArray(record['oneOf'])) {
        for (const variant of record['oneOf'] as unknown[]) {
          walk(variant, path, parentRequired);
        }
      }
      if (Array.isArray(record['anyOf'])) {
        for (const variant of record['anyOf'] as unknown[]) {
          walk(variant, path, parentRequired);
        }
      }
      if (Array.isArray(record['allOf'])) {
        for (const variant of record['allOf'] as unknown[]) {
          walk(variant, path, parentRequired);
        }
      }
    };

    walk(schema, [], true);

    return { required, known, types };
  }

  private extractSchemaTypeLabel(node: unknown): string | null {
    if (!node || typeof node !== 'object') {
      return null;
    }

    const record = node as Record<string, unknown>;
    const typeValue = record['type'];
    if (typeof typeValue === 'string') {
      return typeValue;
    }
    if (Array.isArray(typeValue)) {
      const labels = typeValue.filter((v): v is string => typeof v === 'string');
      return labels.length > 0 ? labels.join(' | ') : null;
    }

    const mergedTypes = [record['oneOf'], record['anyOf'], record['allOf']]
      .filter(Array.isArray)
      .flatMap((variants) =>
        (variants as unknown[])
          .map((variant) => this.extractSchemaTypeLabel(variant))
          .filter((label): label is string => !!label)
      );
    if (mergedTypes.length > 0) {
      return Array.from(new Set(mergedTypes)).join(' | ');
    }

    if (record['properties'] && typeof record['properties'] === 'object') {
      return 'object';
    }
    if (record['items']) {
      return 'array';
    }

    return null;
  }

  private inferTypeFromValue(value: unknown): string | null {
    if (Array.isArray(value)) {
      return 'array';
    }
    if (value === null) {
      return 'null';
    }
    const valueType = typeof value;
    if (valueType === 'object') {
      return 'object';
    }
    if (valueType === 'number') {
      return Number.isInteger(value as number) ? 'integer' : 'number';
    }
    if (valueType === 'string' || valueType === 'boolean') {
      return valueType;
    }
    return null;
  }

  private flattenObjectLeaves(
    value: unknown,
    path: (string | number | null)[] = []
  ): { path: (string | number | null)[]; value: unknown }[] {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return [{ path, value }];
      }
      return value.flatMap((item) => this.flattenObjectLeaves(item, [...path, null]));
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        return [{ path, value }];
      }

      return keys.flatMap((key) => this.flattenObjectLeaves(obj[key], [...path, key]));
    }

    return [{ path, value }];
  }

  /** A claim path as the card heading shows it, with `*` for array items like the matrix. */
  claimPathLabel(path: unknown): string {
    return Array.isArray(path) ? this.pathToKey(path, ' > ') : '';
  }

  private pathToKey(path: (string | number | null)[], separator = '.'): string {
    return path
      .map((segment) => (segment === null || typeof segment === 'number' ? '*' : String(segment)))
      .join(separator);
  }

  private isRowComplete(row: ClaimFieldRow): boolean {
    const hasType = !!row.typeLabel;
    const hasMandatory = row.mandatory !== null;
    const hasDisclosable = this.isMdocFormat
      ? row.disclosableLabel === 'N/A'
      : row.disclosableLabel !== 'Not configured';

    return hasType && hasMandatory && hasDisclosable;
  }

  get canDownloadConfig(): boolean {
    return this.configDocuments.canDownload('CredentialConfig');
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return !!this.config && this.configDocuments.isDownloading('CredentialConfig', this.config.id);
  }

  /**
   * Downloads the configuration as a document that the config folder and
   * configuration bundles import.
   */
  async downloadConfig(): Promise<void> {
    if (!this.config) return;
    await this.configDocuments.downloadWithFeedback('CredentialConfig', this.config.id);
  }

  asAny(obj: any) {
    return obj;
  }
}
