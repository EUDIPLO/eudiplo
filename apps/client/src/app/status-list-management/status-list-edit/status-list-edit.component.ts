import { DatePipe, DecimalPipe } from '@angular/common';
import {
  Component,
  type ElementRef,
  Injector,
  OnInit,
  ChangeDetectionStrategy,
  inject,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { StatusListResponseDto, CredentialConfig, KeyChainResponseDto } from '@eudiplo/sdk-core';
import { StatusListManagementService } from '../status-list-management.service';
import { formatCapacity, getUsageColor, getUsagePercentage } from '../status-list-usage';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { KeyChainService } from '../../key-management/key-chain.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { LabelledFailure, getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { SourceLoadState, loadSource, reportSourceFailures } from '../../common/load-source';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { wholeNumberValidator } from '../../utils/whole-number-validator';
import { showFieldsToFix } from '../../common/field-to-fix.util';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import type { PageWithUnsavedChanges } from '../../services/unsaved-changes.service';

/** The sources of the options of the form's selects. */
type StatusListEditSource = 'credentialConfigs' | 'keyChains';

@Component({
  selector: 'app-status-list-edit',
  imports: [
    DatePipe,
    DecimalPipe,
    ReactiveFormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './status-list-edit.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './status-list-edit.component.scss',
})
export class StatusListEditComponent implements OnInit, PageWithUnsavedChanges {
  listId?: string | null;
  form!: FormGroup;
  isLoading = true;
  isSaving = false;
  /** Set when the status list could not be loaded; the page then offers Retry instead of a form. */
  loadError = '';

  /** The loaded status list (for edit mode) */
  statusList?: StatusListResponseDto;

  /** Available credential configs for binding */
  credentialConfigs: CredentialConfig[] = [];

  /** Available key chains with statusList or attestation usage */
  keyChains: KeyChainResponseDto[] = [];

  /** All key chains of the tenant, to tell why a stored key chain is not offered. */
  private allKeyChains: KeyChainResponseDto[] = [];

  /** Load state of each select's options, so a failed load is not shown as "none exist". */
  readonly loadState: Record<StatusListEditSource, SourceLoadState> = {
    credentialConfigs: 'loading',
    keyChains: 'loading',
  };

  /** Available bits per status options */
  bitsOptions = [1, 2, 4, 8] as const;

  /** Available capacity presets */
  capacityPresets = [
    { value: 10000, label: '10K' },
    { value: 100000, label: '100K' },
    { value: 500000, label: '500K' },
    { value: 1000000, label: '1M' },
  ];

  private readonly injector = inject(Injector);
  private readonly formElement = viewChild<ElementRef<HTMLFormElement>>('formElement');
  /** Takes the focus after a successful Retry, which removed the focused Retry button. */
  private readonly pageHeading = viewChild<ElementRef<HTMLElement>>('pageHeading');

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar,
    private readonly statusListService: StatusListManagementService,
    private readonly credentialConfigService: CredentialConfigService,
    private readonly keyChainService: KeyChainService
  ) {}

  ngOnInit(): void {
    this.listId = this.route.snapshot.paramMap.get('listId');

    this.form = new FormGroup({
      credentialConfigurationId: new FormControl(null),
      keyChainId: new FormControl(null),
      // Only used in create mode
      bits: new FormControl(null),
      // The backend accepts whole numbers from 1,000 to 1,000,000.
      capacity: new FormControl(null, [
        Validators.min(1000),
        Validators.max(1_000_000),
        wholeNumberValidator,
      ]),
    });

    void this.loadData();
  }

  /** Loaders of the options of each select; a source that failed is loaded again on its own. */
  private readonly sources: Record<
    StatusListEditSource,
    () => Promise<LabelledFailure | undefined>
  > = {
    credentialConfigs: () =>
      loadSource(this.loadState, 'credentialConfigs', 'credential configs', async () => {
        this.credentialConfigs = await this.credentialConfigService.loadConfigurations();
      }),
    keyChains: () =>
      loadSource(this.loadState, 'keyChains', 'key chains', async () => {
        this.allKeyChains = await this.keyChainService.getAll();
        this.keyChains = this.allKeyChains.filter(
          (kc: KeyChainResponseDto) =>
            kc.usageType === 'statusList' || kc.usageType === 'attestation'
        );
      }),
  };

  /** Loads the options of one select again, keeping what the user entered. */
  async retrySource(source: StatusListEditSource): Promise<void> {
    reportSourceFailures(this.snackBar, [await this.sources[source]()]);
  }

  /**
   * Loads the options of both selects independently, so one that fails leaves
   * the other usable; failed sources are named in a snackbar and under their select.
   */
  private async loadData(): Promise<void> {
    this.isLoading = true;
    try {
      const failures = await Promise.all([
        this.sources.credentialConfigs(),
        this.sources.keyChains(),
      ]);
      reportSourceFailures(this.snackBar, failures);

      if (this.listId) {
        await this.loadStatusList();
      }
    } finally {
      this.isLoading = false;
    }
  }

  /** Loads the status list again after a failed load, keeping the loaded options. */
  async retryLoad(): Promise<void> {
    this.isLoading = true;
    try {
      await this.loadStatusList();
    } finally {
      this.isLoading = false;
    }
    if (!this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.pageHeading()?.nativeElement);
    }
  }

  private async loadStatusList(): Promise<void> {
    if (!this.listId) return;

    this.loadError = '';
    try {
      this.statusList = await this.statusListService.getList(this.listId);
      this.form.patchValue({
        credentialConfigurationId: this.statusList.credentialConfigurationId ?? null,
        keyChainId: this.statusList.keyChainId ?? null,
      });
    } catch (error) {
      console.error('Failed to load status list:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load status list');
    }
  }

  get isEditMode(): boolean {
    return !!this.listId;
  }

  getUsagePercentage(): number {
    return this.statusList ? getUsagePercentage(this.statusList) : 0;
  }

  getUsageColor(): string {
    return this.statusList ? getUsageColor(this.statusList) : 'primary';
  }

  formatCapacity(capacity: number): string {
    return formatCapacity(capacity);
  }

  getExpirationStatus(): 'valid' | 'expiring' | 'expired' | 'none' {
    if (!this.statusList?.expiresAt) return 'none';
    const expiresAt = new Date(this.statusList.expiresAt);
    const now = new Date();
    const diffMs = expiresAt.getTime() - now.getTime();
    if (diffMs < 0) return 'expired';
    if (diffMs < 60 * 60 * 1000) return 'expiring';
    return 'valid';
  }

  getExpirationLabel(): string {
    const status = this.getExpirationStatus();
    switch (status) {
      case 'valid':
        return 'Valid';
      case 'expiring':
        return 'Expiring Soon';
      case 'expired':
        return 'Expired';
      default:
        return 'Not Generated';
    }
  }

  /**
   * The bound credential config when the select does not offer it, so the select shows its ID
   * instead of looking empty; once the configs are loaded, the label says it does not exist.
   */
  get unlistedCredentialConfig(): { id: string; label: string } | undefined {
    const id: unknown = this.form?.get('credentialConfigurationId')?.value;
    if (typeof id !== 'string' || !id) return undefined;
    if (this.credentialConfigs.some((config) => config.id === id)) return undefined;
    return {
      id,
      label: this.loadState.credentialConfigs === 'loaded' ? `${id} (does not exist)` : id,
    };
  }

  /**
   * The pinned key chain when the select does not offer it, as the trust list form shows one:
   * once the key chains are loaded, the label says whether it has another usage or does not exist.
   */
  get unlistedKeyChain(): { id: string; label: string } | undefined {
    const id: unknown = this.form?.get('keyChainId')?.value;
    if (typeof id !== 'string' || !id) return undefined;
    if (this.keyChains.some((keyChain) => keyChain.id === id)) return undefined;
    if (this.loadState.keyChains !== 'loaded') return { id, label: id };
    return {
      id,
      label: this.allKeyChains.some((keyChain) => keyChain.id === id)
        ? `${id} (not a Status List or Credential Signing key chain)`
        : `${id} (does not exist)`,
    };
  }

  /** Puts a preset into Capacity, as typing it would. */
  setCapacity(capacity: number): void {
    const control = this.form.get('capacity');
    control?.setValue(capacity);
    control?.markAsDirty();
  }

  async copyUri(): Promise<void> {
    if (!this.statusList?.uri) return;
    await copyToClipboard(
      this.snackBar,
      this.statusList.uri,
      'URI copied to clipboard',
      'Could not copy the URI. Select it in the URI field and copy it by hand.'
    );
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty;
  }

  /** Save stays focusable while a save runs, so its tooltip says why it waits. */
  get saveTooltip(): string {
    return this.isSaving ? 'Saving the status list…' : '';
  }

  async onSubmit(): Promise<void> {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
    if (this.isSaving) return;
    if (this.form.invalid) {
      showFieldsToFix(this.form, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement()?.nativeElement,
        sections: [
          {
            name: 'Status List Settings',
            controls: [this.form.get('bits'), this.form.get('capacity')],
          },
        ],
      });
      return;
    }

    this.isSaving = true;
    try {
      const formValue = this.form.value;

      if (this.isEditMode) {
        // The backend keeps a binding that is left out and removes one that is null,
        // so "Shared" and "Default" are sent as null. An unchanged binding is left out:
        // sending the key chain again discards the signed list.
        const dto: { credentialConfigurationId?: string | null; keyChainId?: string | null } = {};
        const credentialConfigurationId: string | null =
          formValue.credentialConfigurationId || null;
        if (credentialConfigurationId !== (this.statusList?.credentialConfigurationId ?? null)) {
          dto.credentialConfigurationId = credentialConfigurationId;
        }
        const keyChainId: string | null = formValue.keyChainId || null;
        if (keyChainId !== (this.statusList?.keyChainId ?? null)) {
          dto.keyChainId = keyChainId;
        }
        if (Object.keys(dto).length === 0) {
          // An empty update would change nothing, yet report success.
          this.form.markAsPristine();
          this.snackBar.open('No changes to save', 'Close', { duration: 3000 });
          return;
        }
        await this.statusListService.updateList(this.listId!, dto);
        this.snackBar.open('Status list updated successfully', 'Close', { duration: 3000 });
      } else {
        const dto = {
          credentialConfigurationId: formValue.credentialConfigurationId || undefined,
          keyChainId: formValue.keyChainId || undefined,
          bits: formValue.bits || undefined,
          capacity: formValue.capacity || undefined,
        };
        await this.statusListService.createList(dto);
        this.snackBar.open('Status list created successfully', 'Close', { duration: 3000 });
      }

      this.form.markAsPristine();
      this.router.navigate(['/status-lists']);
    } catch (error) {
      console.error('Error saving status list:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to save status list'));
    } finally {
      this.isSaving = false;
    }
  }
}
