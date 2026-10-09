import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { getApiErrorMessage } from '../utils/error-message';
import { JwtService } from '../services/jwt.service';
import {
  ConfigBundle,
  ConfigOperation,
  ConfigImportMode,
  ConfigImportPlan,
  ConfigPortabilityService,
  ConfigResourceMetadata,
} from './config-portability.service';

@Component({
  selector: 'app-config-portability',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
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
  readonly resourceColumns = ['select', 'resource', 'ownership', 'generation', 'source', 'actions'];
  mode: ConfigImportMode = 'upsert';
  bundle?: ConfigBundle;
  bundleArchive?: File;
  bundleFileName = '';
  plan?: ConfigImportPlan;
  /** Set while the shown plan resets one resource to its file version. */
  reattachTarget?: ConfigResourceMetadata;
  resources: ConfigResourceMetadata[] = [];
  operations: ConfigOperation[] = [];
  selected = new Set<string>();
  busy = false;

  constructor(
    private readonly portability: ConfigPortabilityService,
    private readonly snackBar: MatSnackBar,
    private readonly jwt: JwtService
  ) {}

  get canApply(): boolean {
    return this.jwt.hasRole('tenants:manage') || this.jwt.hasRole('tenant:admin');
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
        if (
          parsed.manifest?.format !== 'eudiplo.config-bundle' ||
          !Array.isArray(parsed.documents)
        ) {
          throw new Error('This is not an EUDIPLO configuration bundle');
        }
        this.bundle = parsed;
        this.bundleArchive = undefined;
      }
      this.bundleFileName = file.name;
      this.plan = undefined;
      this.reattachTarget = undefined;
    } catch (error) {
      this.bundle = undefined;
      this.bundleArchive = undefined;
      this.bundleFileName = '';
      this.snackBar.open(getApiErrorMessage(error, 'Could not read bundle'), 'Close', {
        duration: 5000,
      });
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
    const confirmed =
      this.mode !== 'replace' ||
      globalThis.confirm(
        'Replace mode deletes file-managed resources from this bundle source that are not in the bundle. Continue?'
      );
    if (!confirmed) return;
    const fingerprint = this.plan.planFingerprint;
    await this.run(async () => {
      this.plan = this.bundleArchive
        ? await this.portability.importArchive(
            this.bundleArchive,
            this.mode,
            confirmed,
            fingerprint
          )
        : await this.portability.import(this.bundle!, this.mode, confirmed, fingerprint);
      await this.refreshResources();
      this.snackBar.open('Configuration bundle imported', 'Close', { duration: 3000 });
    }, 'Configuration import failed');
  }

  async detach(resource: ConfigResourceMetadata): Promise<void> {
    if (
      !globalThis.confirm(
        `Detach ${resource.kind}/${resource.resourceId}? It will become editable through the API and UI.`
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
    await this.run(async () => {
      this.plan = await this.portability.planReattach(resource.kind, resource.resourceId);
      this.reattachTarget = resource;
      // The plan renders above the ownership table, out of view of the clicked row.
      setTimeout(() =>
        document.getElementById('config-plan')?.scrollIntoView({ behavior: 'smooth' })
      );
    }, 'Could not plan the reset to the file version');
  }

  async applyReattach(): Promise<void> {
    const target = this.reattachTarget;
    if (!target || !this.plan?.applicable || !this.plan.planFingerprint || this.plan.operationId)
      return;
    if (
      !globalThis.confirm(
        `Reset ${this.resourceKey(target)} to the file version? Changes made through the API or UI are discarded.`
      )
    ) {
      return;
    }
    const fingerprint = this.plan.planFingerprint;
    await this.run(async () => {
      this.plan = await this.portability.reattach(target.kind, target.resourceId, fingerprint);
      await this.refreshResources();
      this.snackBar.open(`${this.resourceKey(target)} is file-managed again`, 'Close', {
        duration: 3000,
      });
    }, 'Could not reset the resource to the file version');
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
      StatusList: '/status-lists',
    };
    const base = routesByKind[resource.kind];
    if (base) return [base, resource.resourceId];

    const singletonRoutesByKind: Partial<Record<ConfigResourceMetadata['kind'], string>> = {
      IssuanceConfig: '/issuance-config',
      RegistrarConfig: '/registrar',
      KmsConfig: '/kms',
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

  get detachableResources(): ConfigResourceMetadata[] {
    return this.resources.filter((resource) => resource.ownership === 'file-managed');
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
    if (
      !globalThis.confirm(
        `Detach ${targets.length} resource(s)? They will become editable through the API and UI.`
      )
    ) {
      return;
    }
    this.busy = true;
    try {
      const failures: string[] = [];
      for (const resource of targets) {
        try {
          await this.portability.detach(resource.kind, resource.resourceId);
          this.selected.delete(this.resourceKey(resource));
        } catch (error) {
          failures.push(`${this.resourceKey(resource)}: ${getApiErrorMessage(error, 'failed')}`);
        }
      }
      await this.refreshResources();
      const succeeded = targets.length - failures.length;
      if (failures.length) {
        this.snackBar.open(
          `Detached ${succeeded} of ${targets.length} resource(s). Failed: ${failures.join('; ')}`,
          'Close',
          { duration: 8000 }
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
    if (!this.plan?.generatedSecrets?.length) return;
    this.download(
      new Blob([JSON.stringify({ generatedSecrets: this.plan.generatedSecrets }, null, 2)], {
        type: 'application/json',
      }),
      'eudiplo-import-secrets.json'
    );
  }

  async refreshOperations(): Promise<void> {
    try {
      this.operations = await this.portability.listOperations();
    } catch (error) {
      this.snackBar.open(getApiErrorMessage(error, 'Could not load operation history'), 'Close', {
        duration: 5000,
      });
    }
  }

  private async refreshResources(): Promise<void> {
    try {
      this.resources = await this.portability.listResources();
      const validKeys = new Set(this.resources.map((resource) => this.resourceKey(resource)));
      for (const key of this.selected) {
        if (!validKeys.has(key)) this.selected.delete(key);
      }
    } catch (error) {
      this.snackBar.open(getApiErrorMessage(error, 'Could not load resource ownership'), 'Close', {
        duration: 5000,
      });
    }
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
      this.snackBar.open(getApiErrorMessage(error, fallback), 'Close', { duration: 6000 });
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
