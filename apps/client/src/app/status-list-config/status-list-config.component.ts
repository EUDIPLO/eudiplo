import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { StatusListConfigService, bitsOptions } from './status-list-config.service';
import { StatusListConfig, UpdateStatusListConfigDto } from '@eudiplo/sdk-core';
import { ConfigOwnershipDirective } from '../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../config-portability/config-ownership-notice.component';
import { focusAfterRenderIfLost } from '../common/focus-if-lost.util';
import { LoadErrorComponent } from '../common/load-error.component';
import { showFieldsToFix } from '../common/field-to-fix.util';
import { resetDefaultsTooltip, WAIT_FOR_CHANGE } from '../common/reset-defaults';
import { getApiErrorMessage } from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';
import { wholeNumberValidator } from '../utils/whole-number-validator';

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

/** The instance variable that applies to a setting the tenant does not store. */
const globalDefaults: Record<keyof StatusListConfig, string> = {
  capacity: 'STATUS_CAPACITY',
  bits: 'STATUS_BITS',
  ttl: 'STATUS_TTL',
  immediateUpdate: 'STATUS_IMMEDIATE_UPDATE',
  enableAggregation: 'STATUS_ENABLE_AGGREGATION',
};

/** Fixed when a list is created; the other settings apply to every list when it is signed. */
const newListsOnly = new Set<keyof StatusListConfig>(['capacity', 'bits']);

@Component({
  selector: 'app-status-list-config',
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatSelectModule,
    MatIconModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatDividerModule,
    FlexLayoutModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './status-list-config.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './status-list-config.component.scss',
})
export class StatusListConfigComponent implements OnInit {
  configForm: FormGroup;
  isLoading = true;
  isSaving = false;
  /** Set when the stored settings could not be loaded; the form stays hidden. */
  loadError = '';
  currentConfig: StatusListConfig | null = null;

  /**
   * Where focus goes when a retry removes the error card with its focused
   * Retry button, or a reset ends while focus is nowhere.
   */
  @ViewChild('settingsTitle', { read: ElementRef })
  private readonly settingsTitle?: ElementRef<HTMLElement>;
  /** Takes the focus back after a save that ended with focus nowhere; Safari does not focus a clicked button. */
  @ViewChild('saveButton', { read: ElementRef })
  private readonly saveButton?: ElementRef<HTMLButtonElement>;
  private readonly injector = inject(Injector);
  /** Holds the fields; Save focuses the first invalid one. */
  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;

  bitsOptions = bitsOptions;
  Math = Math;

  constructor(
    private readonly fb: FormBuilder,
    private readonly statusListConfigService: StatusListConfigService,
    private readonly snackBar: MatSnackBar
  ) {
    // null follows the instance's STATUS_* variable of the same setting.
    this.configForm = this.fb.group({
      capacity: [null as number | null, [Validators.min(100), wholeNumberValidator]],
      bits: [null as number | null],
      ttl: [null as number | null, [Validators.min(60), wholeNumberValidator]],
      immediateUpdate: [null as boolean | null],
      enableAggregation: [null as boolean | null],
    });
  }

  ngOnInit() {
    void this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    const retrying = this.loadError !== '';
    this.isLoading = true;
    this.loadError = '';
    try {
      this.currentConfig = await this.statusListConfigService.getConfig();
    } catch (error) {
      console.error('Load error:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load status list configuration');
      return;
    } finally {
      this.isLoading = false;
    }
    this.patchForm(this.currentConfig);
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.settingsTitle?.nativeElement);
    }
  }

  /** Whether the tenant overrides any global default, so Reset has something to do. */
  get hasStoredOverride(): boolean {
    return this.storedSettings().length > 0;
  }

  get resetTooltip(): string {
    return resetDefaultsTooltip(this.isSaving, this.hasStoredOverride);
  }

  /** Save stays focusable while another change runs, so its tooltip says why it waits. */
  get saveTooltip(): string {
    return this.isSaving ? WAIT_FOR_CHANGE : '';
  }

  async onSave(): Promise<void> {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    if (this.isSaving || this.loadError) return;
    if (this.configForm.invalid) {
      const control = (name: string) => [this.configForm.get(name)];
      showFieldsToFix(this.configForm, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
        sections: [
          { name: 'Status List Capacity', controls: control('capacity') },
          { name: 'Bits per Status', controls: control('bits') },
          { name: 'JWT Time-to-Live (TTL)', controls: control('ttl') },
          { name: 'JWT Regeneration Mode', controls: control('immediateUpdate') },
          { name: 'Status List Aggregation', controls: control('enableAggregation') },
        ],
      });
      return;
    }

    const update = this.buildUpdate();
    this.isSaving = true;
    try {
      this.currentConfig = await this.statusListConfigService.updateConfig(update);
    } catch (error) {
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to save configuration'));
      return;
    } finally {
      this.isSaving = false;
      focusAfterRenderIfLost(this.injector, () => this.saveButton?.nativeElement);
    }
    this.patchForm(this.currentConfig);
    this.snackBar.open('Status list configuration saved successfully', 'Close', {
      duration: 3000,
    });
  }

  async onReset(): Promise<void> {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    if (this.isSaving || !this.hasStoredOverride || !confirm(this.resetConfirmation())) {
      return;
    }

    this.isSaving = true;
    try {
      await this.statusListConfigService.resetConfig();
    } catch (error) {
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to reset configuration'));
      return;
    } finally {
      this.isSaving = false;
      focusAfterRenderIfLost(this.injector, () => this.settingsTitle?.nativeElement);
    }
    this.currentConfig = null;
    this.patchForm(this.currentConfig);
    this.snackBar.open('Status list configuration reset to defaults', 'Close', {
      duration: 3000,
    });
  }

  private resetConfirmation(): string {
    const stored = this.storedSettings();
    const removed = stored.map((setting) => this.describeStored(setting));
    const variables = (settings: (keyof StatusListConfig)[]) =>
      listFormat.format(settings.map((setting) => globalDefaults[setting]));
    const forNewLists = stored.filter((setting) => newListsOnly.has(setting));
    const forAllLists = stored.filter((setting) => !newListsOnly.has(setting));
    const effects = [
      forNewLists.length ? `new status lists use ${variables(forNewLists)}` : '',
      forAllLists.length
        ? `all status lists, including existing ones, use ${variables(forAllLists)}`
        : '',
    ].filter(Boolean);
    return (
      `Reset the status list settings to the global defaults of this instance? ` +
      `This removes ${listFormat.format(removed)}. Afterwards, ${effects.join('; ')} of this ` +
      `instance. This cannot be undone.`
    );
  }

  /** The settings the tenant stores, which Reset to Defaults removes. */
  private storedSettings(): (keyof StatusListConfig)[] {
    const config = this.currentConfig;
    if (!config) return [];
    return (Object.keys(globalDefaults) as (keyof StatusListConfig)[]).filter(
      (setting) => config[setting] != null
    );
  }

  private describeStored(setting: keyof StatusListConfig): string {
    const config = this.currentConfig ?? {};
    switch (setting) {
      case 'capacity':
        return `the capacity of ${this.formatCapacity(config.capacity)}`;
      case 'bits':
        return `${config.bits} ${config.bits === 1 ? 'bit' : 'bits'} per status`;
      case 'ttl':
        return `the TTL of ${this.formatTtl(config.ttl)}`;
      case 'immediateUpdate':
        return `${config.immediateUpdate ? 'immediate' : 'lazy'} JWT regeneration`;
      case 'enableAggregation':
        return `${config.enableAggregation ? 'enabled' : 'disabled'} aggregation`;
    }
  }

  /**
   * Sends only what the user set. The backend replaces the stored settings, so
   * a setting left at the global default is left out and no longer stored.
   */
  private buildUpdate(): UpdateStatusListConfigDto {
    const chosen = Object.entries(this.configForm.value).filter(([, value]) => value !== null);
    return Object.fromEntries(chosen) as UpdateStatusListConfigDto;
  }

  private patchForm(config: StatusListConfig | null): void {
    this.configForm.patchValue({
      capacity: config?.capacity ?? null,
      bits: config?.bits ?? null,
      ttl: config?.ttl ?? null,
      immediateUpdate: config?.immediateUpdate ?? null,
      enableAggregation: config?.enableAggregation ?? null,
    });
  }

  /** What applies to a setting the tenant does not store. */
  globalDefaultLabel(setting: keyof StatusListConfig): string {
    return `Global default (${globalDefaults[setting]} of this instance)`;
  }

  formatCapacity(capacity?: number | null): string {
    if (!capacity) return this.globalDefaultLabel('capacity');
    return `${capacity.toLocaleString()} entries`;
  }

  formatTtl(ttl?: number | null): string {
    if (!ttl) return this.globalDefaultLabel('ttl');
    if (ttl >= 3600) {
      const hours = ttl / 3600;
      return hours === 1 ? '1 hour' : `${hours} hours`;
    }
    if (ttl >= 60) {
      const minutes = ttl / 60;
      return minutes === 1 ? '1 minute' : `${minutes} minutes`;
    }
    return ttl === 1 ? '1 second' : `${ttl} seconds`;
  }

  // An unset select shows its placeholder, the global default, instead of a trigger.
  immediateUpdateLabel(immediateUpdate: boolean): string {
    return immediateUpdate ? 'Immediate' : 'Lazy';
  }

  aggregationLabel(enableAggregation: boolean): string {
    return enableAggregation ? 'Enabled' : 'Disabled';
  }

  getSelectedBitsLabel(): string {
    const value = this.configForm.get('bits')?.value;
    return this.bitsOptions.find((o) => o.value === value)?.label ?? '';
  }
}
