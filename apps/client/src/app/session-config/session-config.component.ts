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
import { SessionConfigService, SessionCleanupMode, cleanupModes } from './session-config.service';
import { SessionStorageConfig, UpdateSessionConfigDto } from '@eudiplo/sdk-core';
import { ConfigOwnershipDirective } from '../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../config-portability/config-ownership-notice.component';
import { focusAfterRenderIfLost } from '../common/focus-if-lost.util';
import { LoadErrorComponent } from '../common/load-error.component';
import { showFieldsToFix } from '../common/field-to-fix.util';
import { resetDefaultsTooltip, WAIT_FOR_CHANGE } from '../common/reset-defaults';
import { getApiErrorMessage } from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';
import { wholeNumberValidator } from '../utils/whole-number-validator';

@Component({
  selector: 'app-session-config',
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
  templateUrl: './session-config.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './session-config.component.scss',
})
export class SessionConfigComponent implements OnInit {
  configForm: FormGroup;
  isLoading = true;
  isSaving = false;
  /** Set when the stored settings could not be loaded; the form stays hidden. */
  loadError = '';
  currentConfig: SessionStorageConfig | null = null;

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

  cleanupModes = cleanupModes;

  constructor(
    private readonly fb: FormBuilder,
    private readonly sessionConfigService: SessionConfigService,
    private readonly snackBar: MatSnackBar
  ) {
    this.configForm = this.fb.group({
      ttlSeconds: [null as number | null, [Validators.min(60), wholeNumberValidator]],
      // null follows the instance's SESSION_CLEANUP_MODE.
      cleanupMode: [null as SessionCleanupMode | null],
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
      this.currentConfig = await this.sessionConfigService.getConfig();
    } catch (error) {
      console.error('Load error:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load the session settings');
      return;
    } finally {
      this.isLoading = false;
    }
    this.patchForm(this.currentConfig);
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.settingsTitle?.nativeElement);
    }
  }

  /**
   * The update endpoint keeps a stored cleanup mode when the field is omitted
   * and has no value to clear it, so "Use global default" is only offered while
   * no mode is stored. Reset to Defaults clears a stored mode (and the TTL).
   */
  get hasStoredCleanupMode(): boolean {
    return !!this.currentConfig?.cleanupMode;
  }

  /** Whether the tenant overrides any global default, so Reset has something to do. */
  get hasStoredOverride(): boolean {
    return this.hasStoredCleanupMode || !!this.currentConfig?.ttlSeconds;
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
      showFieldsToFix(this.configForm, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
        sections: [
          { name: 'Session Time-to-Live (TTL)', controls: [this.configForm.get('ttlSeconds')] },
          { name: 'Cleanup Mode', controls: [this.configForm.get('cleanupMode')] },
        ],
      });
      return;
    }

    const update = this.buildUpdate();
    this.isSaving = true;
    try {
      this.currentConfig = await this.sessionConfigService.updateConfig(update);
    } catch (error) {
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to save configuration'));
      return;
    } finally {
      this.isSaving = false;
      focusAfterRenderIfLost(this.injector, () => this.saveButton?.nativeElement);
    }
    this.patchForm(this.currentConfig);
    this.snackBar.open('Session configuration saved successfully', 'Close', {
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
      await this.sessionConfigService.resetConfig();
    } catch (error) {
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to reset configuration'));
      return;
    } finally {
      this.isSaving = false;
      focusAfterRenderIfLost(this.injector, () => this.settingsTitle?.nativeElement);
    }
    // The same state a fresh load of a tenant without overrides returns.
    this.currentConfig = {};
    this.patchForm(this.currentConfig);
    this.snackBar.open('Session configuration reset to defaults', 'Close', {
      duration: 3000,
    });
  }

  private resetConfirmation(): string {
    const removed = [
      this.currentConfig?.ttlSeconds
        ? `the TTL of ${this.formatTtl(this.currentConfig.ttlSeconds)}`
        : '',
      this.currentConfig?.cleanupMode
        ? `the cleanup mode "${this.cleanupModeLabel(this.currentConfig.cleanupMode)}"`
        : '',
    ].filter(Boolean);
    return (
      `Reset the session settings to the global defaults of this instance? ` +
      `This removes ${removed.join(' and ')}. From the next cleanup run, sessions older than ` +
      `SESSION_TTL are cleaned up with SESSION_CLEANUP_MODE, which can delete them completely. ` +
      `This cannot be undone.`
    );
  }

  /**
   * Sends only what the user set. An empty TTL is sent as null only to remove
   * a stored override; otherwise unset fields are left out, so they keep
   * following the instance defaults.
   */
  private buildUpdate(): UpdateSessionConfigDto {
    const { ttlSeconds, cleanupMode } = this.configForm.value as {
      ttlSeconds: number | null | '';
      cleanupMode: SessionCleanupMode | null;
    };
    const update: UpdateSessionConfigDto = {};
    if (ttlSeconds !== null && ttlSeconds !== '') {
      update.ttlSeconds = ttlSeconds;
    } else if (this.currentConfig?.ttlSeconds != null) {
      update.ttlSeconds = null;
    }
    if (cleanupMode) {
      update.cleanupMode = cleanupMode;
    }
    return update;
  }

  private patchForm(config: SessionStorageConfig | null): void {
    this.configForm.patchValue({
      ttlSeconds: config?.ttlSeconds ?? null,
      cleanupMode: config?.cleanupMode ?? null,
    });
  }

  /** Spells the TTL out exactly, for example "1 day 12 hours". */
  formatTtl(seconds?: number | null): string {
    if (!seconds) return 'Global default (SESSION_TTL of this instance)';
    const units: [string, number][] = [
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
      ['second', 1],
    ];
    const parts: string[] = [];
    let rest = seconds;
    for (const [unit, size] of units) {
      const count = Math.floor(rest / size);
      if (count > 0) {
        parts.push(this.plural(count, unit));
        rest -= count * size;
      }
    }
    return parts.join(' ') || `${seconds} seconds`;
  }

  cleanupModeLabel(mode?: SessionCleanupMode | null): string {
    return (
      this.cleanupModes.find((m) => m.value === mode)?.label ??
      'Global default (SESSION_CLEANUP_MODE of this instance)'
    );
  }

  private plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
  }
}
