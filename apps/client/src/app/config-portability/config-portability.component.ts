import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  LabelledFailure,
  apiErrorDetail,
  getApiErrorMessage,
  groupUnreachable,
  joinFailures,
} from '../utils/error-message';
import { JwtService, TENANT_ADMIN_ROLES } from '../services/jwt.service';
import {
  ConfigBundle,
  ConfigOperation,
  ConfigImportMode,
  ConfigImportPlan,
  ConfigPlanChange,
  ConfigPlanItem,
  ConfigPortabilityService,
  ConfigResourceMetadata,
} from './config-portability.service';
import { openErrorSnackBar } from '../utils/error-snackbar';
import { copyToClipboard } from '../utils/copy-to-clipboard';
import {
  ConfigResourceKind,
  ConfigResourceOwnership,
  offersApplyFromFile,
  offersResetToFile,
} from './config-ownership.service';
import { isConfigDocument, singleDocumentBundle } from './config-document-bundle';
import { LoadErrorComponent } from '../common/load-error.component';
import { focusIfFocusWasLost } from '../common/focus-if-lost.util';

/**
 * How one side of a field change reads in the plan: a value, a word naming what is not shown,
 * or the removal of the stored value.
 */
export interface ChangeSide {
  text: string;
  kind: 'value' | 'described' | 'removed';
}

/**
 * A change whose `after` is missing removes the stored value. A `null` is a value: in a DCQL
 * claims path, for example, it selects all array elements.
 */
const removesValue = (change: ConfigPlanChange) => change.after === undefined;

const fieldCount = (count: number) => `${count} ${count === 1 ? 'field' : 'fields'}`;

type ConfigOwnership = ConfigResourceOwnership['ownership'];

const OWNERSHIP_STATES: ConfigOwnership[] = ['file-managed', 'detached', 'unmanaged'];

/** An option of a resource filter, with the number of rows choosing it shows. */
export interface FilterOption<T> {
  value: T;
  count: number;
}

const resourceCount = (count: number) => `${count} ${count === 1 ? 'resource' : 'resources'}`;

@Component({
  selector: 'app-config-portability',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    LoadErrorComponent,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTableModule,
    MatTooltipModule,
  ],
  templateUrl: './config-portability.component.html',
  styleUrl: './config-portability.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ConfigPortabilityComponent implements OnInit {
  readonly planColumns = ['resource', 'version', 'action', 'issues'];
  readonly changeColumns = ['path', 'before', 'after'];
  readonly resourceColumns = ['select', 'resource', 'ownership', 'generation', 'source', 'actions'];
  mode: ConfigImportMode = 'upsert';
  bundle?: ConfigBundle;
  bundleArchive?: File;
  bundleFileName = '';
  plan?: ConfigImportPlan;
  /** Set while the shown plan resets one resource to its file version. */
  reattachTarget?: ConfigResourceMetadata;
  resourcesLoading = false;
  /** Why the last load of the resource ownership failed, or empty after a successful load. */
  resourcesLoadError = '';
  private resourcesRequest = 0;
  /** Kinds the resource table shows; empty shows all kinds. */
  kindFilter: ConfigResourceKind[] = [];
  /** Ownership states the resource table shows; empty shows all. */
  ownershipFilter: ConfigOwnership[] = [];
  /** Text the resource ID or the source contains, ignoring case. */
  search = '';
  /** The rows of the resource table: the resources that pass the filters. */
  shownResources: ConfigResourceMetadata[] = [];
  kindOptions: FilterOption<ConfigResourceKind>[] = [];
  ownershipOptions: FilterOption<ConfigOwnership>[] = [];
  @ViewChild('searchInput') private readonly searchInput?: ElementRef<HTMLInputElement>;
  private allResources: ConfigResourceMetadata[] = [];
  operations: ConfigOperation[] = [];
  operationsLoading = false;
  /** Why the last load of the operation history failed, or empty after a successful load. */
  operationsLoadError = '';
  private operationsRequest = 0;
  selected = new Set<string>();
  busy = false;
  /**
   * Secrets that applies on this page generated. They stay until dismissed, so
   * planning the next import or reset cannot discard a value shown only once.
   */
  generatedSecrets: NonNullable<ConfigImportPlan['generatedSecrets']> = [];

  /** Takes the focus after a successful retry, which removed the focused Retry button. */
  @ViewChild('resourcesTitle', { read: ElementRef })
  private readonly resourcesTitle?: ElementRef<HTMLElement>;

  @ViewChild('operationsTitle', { read: ElementRef })
  private readonly operationsTitle?: ElementRef<HTMLElement>;

  constructor(
    private readonly portability: ConfigPortabilityService,
    private readonly snackBar: MatSnackBar,
    private readonly jwt: JwtService
  ) {}

  /** The shown plan has been applied. A refused apply keeps its operation ID but is not applicable. */
  get applied(): boolean {
    return !!this.plan?.operationId && this.plan.applicable;
  }

  get canApply(): boolean {
    return this.jwt.hasRole(TENANT_ADMIN_ROLES);
  }

  get resources(): ConfigResourceMetadata[] {
    return this.allResources;
  }

  set resources(resources: ConfigResourceMetadata[]) {
    this.allResources = resources;
    this.applyFilters();
  }

  get hasActiveFilters(): boolean {
    return !!(this.kindFilter.length || this.ownershipFilter.length || this.search.trim());
  }

  /** "12 resources", or "Showing 3 of 12 resources" while a filter is active. */
  get resourceSummary(): string {
    const total = resourceCount(this.allResources.length);
    return this.hasActiveFilters ? `Showing ${this.shownResources.length} of ${total}` : total;
  }

  applyFilters(): void {
    this.filterRows();
    // "Detach selected" acts only on rows in view: a filter drops the selection of the rows it
    // hides, and a refresh drops the selection of resources that are gone.
    const shown = new Set(this.shownResources.map((resource) => this.resourceKey(resource)));
    for (const key of this.selected) {
      if (!shown.has(key)) this.selected.delete(key);
    }
  }

  private filterRows(): void {
    const search = this.search.trim().toLowerCase();
    const ofKind = (resource: ConfigResourceMetadata) =>
      !this.kindFilter.length || this.kindFilter.includes(resource.kind);
    const ofOwnership = (resource: ConfigResourceMetadata) =>
      !this.ownershipFilter.length || this.ownershipFilter.includes(resource.ownership);
    // The search matches the Resource and Source columns as they read.
    const found = (resource: ConfigResourceMetadata) =>
      !search ||
      [this.resourceKey(resource), this.sourceLabel(resource)].some((text) =>
        text.toLowerCase().includes(search)
      );
    this.shownResources = this.allResources.filter(
      (resource) => ofKind(resource) && ofOwnership(resource) && found(resource)
    );

    // Each menu counts the rows an option shows with the other filters applied. A chosen kind
    // stays an option after its last resource is gone, so it can be deselected.
    const kinds = new Map<ConfigResourceKind, number>();
    for (const kind of [...this.kindFilter, ...this.allResources.map(({ kind }) => kind)])
      kinds.set(kind, 0);
    const ownerships = new Map(OWNERSHIP_STATES.map((ownership) => [ownership, 0]));
    for (const resource of this.allResources) {
      if (!found(resource)) continue;
      if (ofOwnership(resource)) kinds.set(resource.kind, kinds.get(resource.kind)! + 1);
      if (ofKind(resource))
        ownerships.set(resource.ownership, (ownerships.get(resource.ownership) ?? 0) + 1);
    }
    this.kindOptions = [...kinds]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));
    this.ownershipOptions = [...ownerships].map(([value, count]) => ({ value, count }));
  }

  /** The clear buttons leave the page, so focus moves to the search field. */
  clearSearch(): void {
    this.search = '';
    this.applyFilters();
    this.searchInput?.nativeElement.focus();
  }

  clearFilters(): void {
    this.kindFilter = [];
    this.ownershipFilter = [];
    this.clearSearch();
  }

  sourceLabel(resource: ConfigResourceMetadata): string {
    return resource.source || 'API / UI';
  }

  ngOnInit(): void {
    void this.refreshResources();
    if (this.canApply) void this.refreshOperations();
  }

  async exportBundle(): Promise<void> {
    await this.run(async () => {
      const bundle = await this.portability.exportArchive();
      const date = new Date().toISOString().slice(0, 10);
      this.download(bundle, `eudiplo-config-${date}.zip`);
      this.snackBar.open('Configuration archive exported', 'Close', {
        duration: 3000,
      });
    }, 'Configuration export failed');
  }

  async exportEditableJson(): Promise<void> {
    await this.run(async () => {
      const bundle = await this.portability.exportBundle();
      const date = new Date().toISOString().slice(0, 10);
      this.download(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
        `eudiplo-config-${date}.json`
      );
      this.snackBar.open('Editable configuration bundle exported', 'Close', {
        duration: 3000,
      });
    }, 'Configuration export failed');
  }

  async selectBundle(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        this.bundleArchive = file;
        this.bundle = undefined;
      } else {
        const parsed = JSON.parse(await file.text()) as ConfigBundle;
        if (isConfigDocument(parsed)) {
          // A single resource, as "Download configuration" saves it.
          this.bundle = await singleDocumentBundle(parsed, this.jwt.getTenantId() ?? '');
        } else if (
          parsed.manifest?.format !== 'eudiplo.config-bundle' ||
          !Array.isArray(parsed.documents)
        ) {
          throw new Error(
            'This is neither an EUDIPLO configuration bundle nor a configuration document'
          );
        } else {
          this.bundle = parsed;
        }
        this.bundleArchive = undefined;
      }
      this.bundleFileName = file.name;
      this.plan = undefined;
      this.reattachTarget = undefined;
    } catch (error) {
      this.bundle = undefined;
      this.bundleArchive = undefined;
      this.bundleFileName = '';
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Could not read bundle'));
    } finally {
      input.value = '';
    }
  }

  async planImport(): Promise<void> {
    if (!this.bundle && !this.bundleArchive) return;
    this.reattachTarget = undefined;
    await this.run(async () => {
      this.plan = this.bundleArchive
        ? await this.portability.planArchive(this.bundleArchive, this.mode)
        : await this.portability.plan(this.bundle!, this.mode);
    }, 'Import plan failed');
  }

  async applyImport(): Promise<void> {
    if (
      (!this.bundle && !this.bundleArchive) ||
      !this.plan?.applicable ||
      !this.plan.planFingerprint ||
      this.plan.operationId ||
      this.reattachTarget
    )
      return;
    const question = this.applyQuestion(this.plan);
    if (question && !globalThis.confirm(question)) return;
    const confirmReplace = this.mode === 'replace';
    const fingerprint = this.plan.planFingerprint;
    await this.run(async () => {
      this.plan = this.bundleArchive
        ? await this.portability.importArchive(
            this.bundleArchive,
            this.mode,
            confirmReplace,
            fingerprint
          )
        : await this.portability.import(this.bundle!, this.mode, confirmReplace, fingerprint);
      this.keepGeneratedSecrets(this.plan.generatedSecrets);
      await this.refreshResources();
      this.snackBar.open('Configuration bundle imported', 'Close', { duration: 3000 });
    }, 'Configuration import failed');
  }

  async detach(resource: ConfigResourceMetadata): Promise<void> {
    if (
      !globalThis.confirm(
        `Detach ${resource.kind}/${resource.resourceId}? It will become editable through the API and UI, and imports from its source skip it${
          offersResetToFile(resource.kind, { ...resource, ownership: 'detached' })
            ? ' until you reset it to the file version'
            : ''
        }.`
      )
    ) {
      return;
    }
    await this.run(async () => {
      await this.portability.detach(resource.kind, resource.resourceId);
      this.selected.delete(this.resourceKey(resource));
      await this.refreshResources();
    }, 'Could not detach resource');
  }

  async planReattach(resource: ConfigResourceMetadata): Promise<void> {
    await this.run(
      async () => {
        this.plan = await this.portability.planReattach(resource.kind, resource.resourceId);
        this.reattachTarget = resource;
        // The plan renders above the ownership table, out of view of the clicked row.
        setTimeout(() =>
          document.getElementById('config-plan')?.scrollIntoView({ behavior: 'smooth' })
        );
      },
      resource.ownership === 'file-managed'
        ? 'Could not plan applying the file version'
        : 'Could not plan the reset to the file version'
    );
  }

  async applyReattach(): Promise<void> {
    const target = this.reattachTarget;
    if (!target || !this.plan?.applicable || !this.plan.planFingerprint || this.plan.operationId)
      return;
    const key = this.resourceKey(target);
    const reapply = this.reappliesFileVersion;
    const question = reapply
      ? `Apply ${key} from the config folder again?`
      : `Reset ${key} to the file version? Changes made through the API or UI are discarded.`;
    const secretNotice = this.planRegeneratesClientSecret
      ? ` ${target.resourceId} gets a new secret, and its current secret stops working immediately.`
      : '';
    if (!globalThis.confirm(question + secretNotice)) {
      return;
    }
    const fingerprint = this.plan.planFingerprint;
    await this.run(
      async () => {
        this.plan = await this.portability.reattach(target.kind, target.resourceId, fingerprint);
        this.keepGeneratedSecrets(this.plan.generatedSecrets);
        await this.refreshResources();
        this.snackBar.open(
          reapply ? `${key} was applied from the file` : `${key} is file-managed again`,
          'Close',
          { duration: 3000 }
        );
      },
      reapply
        ? 'Could not apply the file version'
        : 'Could not reset the resource to the file version'
    );
  }

  canApplyFromFile(resource: ConfigResourceMetadata): boolean {
    return offersApplyFromFile(resource.kind, resource);
  }

  canResetToFile(resource: ConfigResourceMetadata): boolean {
    return offersResetToFile(resource.kind, resource);
  }

  /**
   * The plan lists `/spec/secret` when applying it replaces the secret of an
   * existing client: with a new generated one for "secret": "!generate", or
   * with the one in the file.
   */
  get planRegeneratesClientSecret(): boolean {
    return !!this.plan?.items.some(
      (item) =>
        item.kind === 'Client' &&
        item.action === 'update' &&
        item.changes?.some((change) => change.path === '/spec/secret')
    );
  }

  /** True while the shown plan applies the file version of a resource that is still file-managed. */
  get reappliesFileVersion(): boolean {
    return this.reattachTarget?.ownership === 'file-managed';
  }

  /** The field changes of an item at a glance, for example "3 fields, 1 removed". */
  changeSummary(item: ConfigPlanItem): string {
    const changes = item.changes ?? [];
    const removed = changes.filter(removesValue).length;
    return removed
      ? `${fieldCount(changes.length)}, ${removed} removed`
      : fieldCount(changes.length);
  }

  changeSide(change: ConfigPlanChange, side: 'before' | 'after'): ChangeSide {
    const value = change[side];
    if (side === 'after' && removesValue(change)) return { text: 'removed', kind: 'removed' };
    if (value === undefined) return { text: 'not set', kind: 'described' };
    // Markers of configChanges in packages/eudiplo-config-format/src/config-values.ts.
    if (change.redacted && value === '[redacted]') return { text: 'secret', kind: 'described' };
    if (change.redacted && value === '[changed]') return { text: 'changed', kind: 'described' };
    return { text: JSON.stringify(value), kind: 'value' };
  }

  hasRedactedChanges(plan: ConfigImportPlan): boolean {
    return plan.items.some((item) => item.changes?.some((change) => change.redacted));
  }

  resourceKey(resource: ConfigResourceMetadata): string {
    return `${resource.kind}/${resource.resourceId}`;
  }

  /** Route to view the resource, or null when the kind has no dedicated detail page. */
  resourceLink(resource: ConfigResourceMetadata): string[] | null {
    const routesByKind: Partial<Record<ConfigResourceMetadata['kind'], string>> = {
      Tenant: '/tenants',
      Client: '/clients',
      KeyChain: '/keys',
      CredentialConfig: '/credential-config',
      PresentationConfig: '/presentation-config',
      AttributeProvider: '/attribute-providers',
      WebhookEndpoint: '/webhook-endpoints',
      TrustList: '/trust-list',
      FederationTrustAnchor: '/federation-trust-anchor',
      StatusList: '/status-lists',
    };
    const base = routesByKind[resource.kind];
    if (base) return [base, resource.resourceId];

    const singletonRoutesByKind: Partial<Record<ConfigResourceMetadata['kind'], string>> = {
      IssuanceConfig: '/issuance-config',
      RegistrarConfig: '/registrar',
      KmsConfig: '/kms',
      KeyChainDefaults: '/keys',
    };
    const singleton = singletonRoutesByKind[resource.kind];
    return singleton ? [singleton] : null;
  }

  isSelected(resource: ConfigResourceMetadata): boolean {
    return this.selected.has(this.resourceKey(resource));
  }

  selectResource(resource: ConfigResourceMetadata): void {
    this.selected.add(this.resourceKey(resource));
  }

  deselectResource(resource: ConfigResourceMetadata): void {
    this.selected.delete(this.resourceKey(resource));
  }

  /** The file-managed resources in view, which "Select all" selects. */
  get detachableResources(): ConfigResourceMetadata[] {
    return this.shownResources.filter((resource) => resource.ownership === 'file-managed');
  }

  get allSelected(): boolean {
    const detachable = this.detachableResources;
    return detachable.length > 0 && detachable.every((resource) => this.isSelected(resource));
  }

  selectAll(): void {
    for (const resource of this.detachableResources) {
      this.selectResource(resource);
    }
  }

  deselectAll(): void {
    this.selected.clear();
  }

  async detachSelected(): Promise<void> {
    const targets = this.resources.filter((resource) => this.isSelected(resource));
    if (!targets.length) return;
    // "Select all" picks every file-managed row in view, so the question names them.
    const keys = targets.map((resource) => this.resourceKey(resource)).join(', ');
    if (
      !globalThis.confirm(
        `Detach ${targets.length} resource(s): ${keys}? They will become editable through the API and UI, and imports from their source skip them.`
      )
    ) {
      return;
    }
    this.busy = true;
    try {
      const failures: LabelledFailure[] = [];
      for (const resource of targets) {
        try {
          await this.portability.detach(resource.kind, resource.resourceId);
          this.selected.delete(this.resourceKey(resource));
        } catch (error) {
          failures.push({ label: this.resourceKey(resource), error });
        }
      }
      await this.refreshResources();
      const succeeded = targets.length - failures.length;
      if (failures.length) {
        const summary = `Detached ${succeeded} of ${targets.length} resource(s)`;
        // The backend answered none of them: the failed resources stay selected, so the reason is enough.
        const { unreachable, other } = groupUnreachable(failures, () => summary);
        const reasons = joinFailures(
          failures,
          ({ label, error }) => `${label}: ${apiErrorDetail(error) ?? 'failed'}`,
          (labels) => labels
        );
        openErrorSnackBar(
          this.snackBar,
          unreachable && other.length === 0 ? unreachable : `${summary}. Failed: ${reasons}`
        );
      } else {
        this.snackBar.open(`Detached ${succeeded} resource(s)`, 'Close', { duration: 3000 });
      }
    } finally {
      this.busy = false;
    }
  }

  onModeChange(): void {
    this.plan = undefined;
    this.reattachTarget = undefined;
  }

  downloadImportResult(): void {
    if (!this.generatedSecrets.length) return;
    this.download(
      new Blob([JSON.stringify({ generatedSecrets: this.generatedSecrets }, null, 2)], {
        type: 'application/json',
      }),
      'eudiplo-import-secrets.json'
    );
  }

  async copySecret(secret: { id: string; value: string }): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      secret.value,
      `Secret of ${secret.id} copied to clipboard`,
      'Could not copy the secret. Select it and copy it by hand.'
    );
  }

  dismissGeneratedSecrets(): void {
    if (
      !globalThis.confirm(
        'Remove the generated secrets from this page? They cannot be shown again; download or copy them first.'
      )
    )
      return;
    this.generatedSecrets = [];
  }

  /** A later secret of the same client replaces the earlier one, which no longer works. */
  private keepGeneratedSecrets(secrets: ConfigImportPlan['generatedSecrets']): void {
    if (!secrets?.length) return;
    const ids = new Set(secrets.map((secret) => secret.id));
    this.generatedSecrets = [
      ...this.generatedSecrets.filter((secret) => !ids.has(secret.id)),
      ...secrets,
    ];
  }

  async refreshOperations(): Promise<void> {
    // The reload after every action can overlap a Retry or Refresh history; only the latest
    // request shows its result.
    const request = ++this.operationsRequest;
    this.operationsLoading = true;
    this.operationsLoadError = '';
    try {
      const operations = await this.portability.listOperations();
      if (request !== this.operationsRequest) return;
      this.operations = operations;
    } catch (error) {
      if (request !== this.operationsRequest) return;
      // The entries of an earlier load may be out of date: the next load shows the spinner, not them.
      this.operations = [];
      this.operationsLoadError = getApiErrorMessage(error, 'Could not load operation history');
    } finally {
      if (request === this.operationsRequest) this.operationsLoading = false;
    }
  }

  async retryOperations(): Promise<void> {
    await this.refreshOperations();
    // The retry removed the error card with its focused Retry; the title is always rendered.
    if (!this.operationsLoadError) focusIfFocusWasLost(this.operationsTitle?.nativeElement);
  }

  async retryResources(): Promise<void> {
    await this.refreshResources();
    // The retry removed the error card with its focused Retry. The title is always rendered, so it
    // can take the focus without waiting for the next render.
    if (!this.resourcesLoadError) focusIfFocusWasLost(this.resourcesTitle?.nativeElement);
  }

  private async refreshResources(): Promise<void> {
    // A Retry can overlap the reload after an action; only the latest request shows its result.
    const request = ++this.resourcesRequest;
    this.resourcesLoading = true;
    this.resourcesLoadError = '';
    try {
      const resources = await this.portability.listResources();
      if (request !== this.resourcesRequest) return;
      this.resources = resources;
    } catch (error) {
      if (request !== this.resourcesRequest) return;
      // The rows of an earlier load may be out of date: the next load shows the spinner, not them.
      // The selection stays, so the resources a failed detach left selected are still selected.
      this.allResources = [];
      this.filterRows();
      this.resourcesLoadError = getApiErrorMessage(error, 'Could not load resource ownership');
    } finally {
      if (request === this.resourcesRequest) this.resourcesLoading = false;
    }
  }

  /** What to confirm before the plan is applied, or undefined when it needs no confirmation. */
  private applyQuestion(plan: ConfigImportPlan): string | undefined {
    const parts: string[] = [];
    const deletions = plan.items
      .filter((item) => item.action === 'delete')
      .map((item) => `${item.kind}/${item.id}`);
    if (this.mode === 'replace')
      parts.push(
        deletions.length
          ? `Replace mode deletes file-managed resources from this bundle source that are not in the bundle: ${deletions.join(', ')}.`
          : 'This replace import deletes no resources.'
      );
    const removals = plan.items.flatMap((item) => {
      const count = item.changes?.filter(removesValue).length ?? 0;
      return count ? [`${item.kind}/${item.id} (${fieldCount(count)})`] : [];
    });
    if (removals.length)
      parts.push(
        `The import removes stored values that the bundle leaves out, marked as removed in the plan: ${removals.join(', ')}.`
      );
    if (deletions.length || removals.length) parts.push('This cannot be undone.');
    return parts.length ? `${parts.join(' ')} Continue?` : undefined;
  }

  private async run(operation: () => Promise<void>, fallback: string): Promise<void> {
    this.busy = true;
    try {
      await operation();
    } catch (error) {
      const report = error as {
        operationId?: string;
        generatedSecrets?: ConfigImportPlan['generatedSecrets'];
      };
      if (this.plan && report?.operationId)
        this.plan = {
          ...this.plan,
          applicable: false,
          operationId: report.operationId,
          generatedSecrets: report.generatedSecrets,
        };
      this.keepGeneratedSecrets(report?.generatedSecrets);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, fallback));
    } finally {
      this.busy = false;
      if (this.canApply) await this.refreshOperations();
    }
  }

  private download(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
}
