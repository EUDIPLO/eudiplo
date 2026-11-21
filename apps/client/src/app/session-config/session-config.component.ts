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
import { SessionConfigService, SessionCleanupMode, cleanupModes } from './session-config.service';
import { SessionStorageConfig, UpdateSessionConfigDto } from '@eudiplo/sdk-core';
import { ConfigOwnershipDirective } from '../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../config-portability/config-ownership-notice.component';
import { focusAfterRenderIfLost } from '../common/focus-if-lost.util';
import { LoadErrorComponent } from '../common/load-error.component';
import { showFieldsToFix } from '../common/field-to-fix.util';
import { resetDefaultsTooltip, WAIT_FOR_CHANGE } from '../common/reset-defaults';
import { DELETED_SESSION_CREDENTIALS } from '../session-management/session-delete-question';
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

  /** Common TTLs; null clears the TTL, so the global default applies. */
  readonly ttlPresets: { label: string; seconds: number | null }[] = [
    { label: '1 hour', seconds: 3600 },
    { label: '24 hours', seconds: 86400 },
    { label: '7 days', seconds: 604800 },
    { label: '30 days', seconds: 2592000 },
    { label: 'Use default', seconds: null },
  ];

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

  /** Whether the TTL field holds this preset; an empty field matches "Use default". */
  isTtlPreset(seconds: number | null): boolean {
    return this.formTtl() === seconds;
  }

  /** Whether the form differs from the stored settings, including changes made by a preset. */
  get hasChanges(): boolean {
    const cleanupMode = (this.configForm.get('cleanupMode')?.value ?? null) as string | null;
    return (
      this.formTtl() !== (this.currentConfig?.ttlSeconds ?? null) ||
      cleanupMode !== (this.currentConfig?.cleanupMode ?? null)
    );
  }

  /** The TTL field as a number, null while it is empty. */
  private formTtl(): number | null {
    const value = this.configForm.get('ttlSeconds')?.value as number | '' | null | undefined;
    return value === '' || value == null ? null : value;
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
    const question = this.saveConfirmation(update);
    if (question && !confirm(question)) return;
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

  /** Shown beside "Full Delete": what deleting a session means for its credentials. */
  readonly deletedSessionCredentials = DELETED_SESSION_CREDENTIALS;

  /**
   * What to confirm before a save that lets cleanup delete sessions sooner or completely:
   * switching to Full Delete, or a shorter TTL (or a first one, whose length against the global
   * SESSION_TTL is not known here) while cleanup may delete. Anonymize keeps the sessions, so
   * their credentials can still be revoked. Undefined when the save needs no confirmation.
   */
  private saveConfirmation(update: UpdateSessionConfigDto): string | undefined {
    const storedMode = this.currentConfig?.cleanupMode;
    const mode = update.cleanupMode ?? storedMode;
    if (mode === 'anonymize') return undefined;
    const storedTtl = this.currentConfig?.ttlSeconds;
    const toFullDelete = update.cleanupMode === 'full' && storedMode !== 'full';
    const shorterTtl =
      typeof update.ttlSeconds === 'number' && (!storedTtl || update.ttlSeconds < storedTtl);
    if (!toFullDelete && !shorterTtl) return undefined;

    let age = 'SESSION_TTL';
    if (typeof update.ttlSeconds === 'number') age = this.formatTtl(update.ttlSeconds);
    else if (storedTtl) age = this.formatTtl(storedTtl);
    const cleanup =
      mode === 'full'
        ? `sessions older than ${age} are deleted completely`
        : `sessions older than ${age} are cleaned up with SESSION_CLEANUP_MODE, which can delete them completely`;
    return (
      `Save the session settings? From the next cleanup run, ${cleanup}. ` +
      `${DELETED_SESSION_CREDENTIALS} This cannot be undone.`
    );
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
