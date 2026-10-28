import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
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
import { MatChipsModule } from '@angular/material/chips';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { StatusListResponseDto, CredentialConfig, KeyChainResponseDto } from '@eudiplo/sdk-core';
import { StatusListManagementService } from '../status-list-management.service';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { KeyChainService } from '../../key-management/key-chain.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { LabelledFailure, getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { SourceLoadState, loadSource, reportSourceFailures } from '../../common/load-source';
import { copyToClipboard } from '../../utils/copy-to-clipboard';

/** The sources of the options of the form's selects. */
type StatusListEditSource = 'credentialConfigs' | 'keyChains';

@Component({
  selector: 'app-status-list-edit',
  imports: [
    CommonModule,
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
    MatChipsModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
  ],
  templateUrl: './status-list-edit.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './status-list-edit.component.scss',
})
export class StatusListEditComponent implements OnInit {
  listId?: string | null;
  form!: FormGroup;
  isLoading = true;
  isSaving = false;

  /** The loaded status list (for edit mode) */
  statusList?: StatusListResponseDto;

  /** Available credential configs for binding */
  credentialConfigs: CredentialConfig[] = [];

  /** Available key chains with statusList or attestation usage */
  keyChains: KeyChainResponseDto[] = [];

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
      capacity: new FormControl(null),
    });

    void this.loadData();
  }

  /** Loaders of the options of each select; a source that failed is loaded again on its own. */
  private readonly sources: Record<
    StatusListEditSource,
    () => Promise<LabelledFailure | undefined>
  > = {
    credentialConfigs: () =>
      loadSource(this.loadState, 'credentialConfigs', 'credential configurations', async () => {
        this.credentialConfigs = await this.credentialConfigService.loadConfigurations();
      }),
    keyChains: () =>
      loadSource(this.loadState, 'keyChains', 'key chains', async () => {
        this.keyChains = (await this.keyChainService.getAll()).filter(
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

  private async loadStatusList(): Promise<void> {
    if (!this.listId) return;

    try {
      this.statusList = await this.statusListService.getList(this.listId);
      this.form.patchValue({
        credentialConfigurationId: this.statusList.credentialConfigurationId ?? null,
        keyChainId: this.statusList.keyChainId ?? null,
      });
    } catch (error) {
      console.error('Failed to load status list:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to load status list'));
      this.router.navigate(['/status-lists']);
    }
  }

  get isEditMode(): boolean {
    return !!this.listId;
  }

  getUsagePercentage(): number {
    if (!this.statusList) return 0;
    return this.statusListService.getUsagePercentage(this.statusList);
  }

  getUsageColor(): string {
    const percentage = this.getUsagePercentage();
    if (percentage >= 90) return 'warn';
    if (percentage >= 70) return 'accent';
    return 'primary';
  }

  formatCapacity(capacity: number): string {
    return this.statusListService.formatCapacity(capacity);
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

  async copyUri(): Promise<void> {
    if (!this.statusList?.uri) return;
    await copyToClipboard(
      this.snackBar,
      this.statusList.uri,
      'URI copied to clipboard',
      'Could not copy the URI. Select it in the URI field and copy it by hand.'
    );
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.isSaving = true;
    try {
      const formValue = this.form.value;

      if (this.isEditMode) {
        const dto = {
          credentialConfigurationId: formValue.credentialConfigurationId || undefined,
          keyChainId: formValue.keyChainId || undefined,
        };
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

      this.router.navigate(['/status-lists']);
    } catch (error) {
      console.error('Error saving status list:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to save status list'));
    } finally {
      this.isSaving = false;
    }
  }
}
