import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  RegistrarConfig,
  RegistrarConfigRequest,
  RegistrarService,
  RelyingPartyContact,
} from './registrar.service';
import { ConfigOwnershipDirective } from '../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../config-portability/config-ownership-notice.component';
import { focusAfterRenderIfLost } from '../common/focus-if-lost.util';
import { LoadErrorComponent } from '../common/load-error.component';
import { showFieldsToFix } from '../common/field-to-fix.util';
import { WAIT_FOR_CHANGE } from '../common/reset-defaults';
import {
  ConfigOwnershipService,
  ConfigResourceOwnership,
} from '../config-portability/config-ownership.service';
import { getHttpErrorMessage, getValidationIssues } from '../utils/error-message';
import { httpUrlValidator } from '../utils/http-url-validator';
import { registrarBaseUrlValidator } from './registrar-url.validator';
import { openErrorSnackBar } from '../utils/error-snackbar';

interface RegistrarPreset {
  name: string;
  registrarUrl: string;
  oidcUrl: string;
  clientId: string;
  clientSecret?: string;
}

/**
 * Keys of `registrationCertificateDefaults` the form edits. The stored
 * defaults can hold more, such as `provides_attestations`; saving keeps them.
 */
const FORM_DEFAULTS = ['privacy_policy', 'support_uri', 'intermediary'] as const;

/** Fields of the relying party contact, as the registrar names them. */
const CONTACT_FIELDS = ['supportUri', 'email', 'phone'] as const;

/** Labels of the form fields that match a field of the request body. */
const FIELD_LABELS: Record<string, string> = {
  registrarUrl: 'Registrar URL',
  oidcUrl: 'OIDC URL',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  username: 'Username',
  password: 'Password',
  'relyingPartyContact.supportUri': 'Contact Support URL',
  'relyingPartyContact.email': 'Email',
  'relyingPartyContact.phone': 'Phone',
};

/** An absolute https URL, as the backend's `z.url({ protocol: /^https$/ })` checks it. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The registrar's rules for contact values, which the backend repeats. The
 * registrar only accepts https support URLs.
 */
const CONTACT_RULES: Record<(typeof CONTACT_FIELDS)[number], (value: string) => boolean> = {
  supportUri: isHttpsUrl,
  email: (value) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value),
  phone: (value) => /^[+0-9()\-\s]{5,40}$/.test(value),
};

/**
 * Checks a contact value against its rule. Surrounding whitespace is ignored,
 * as the value is sent trimmed; an empty value passes. The error key is
 * `pattern`.
 */
function contactValidator(rule: (value: string) => boolean): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = `${control.value ?? ''}`.trim();
    return !value || rule(value) ? null : { pattern: true };
  };
}

/** Message under a contact field whose value breaks its rule. */
const CONTACT_PATTERN_MESSAGES: Record<string, string> = {
  'relyingPartyContact.supportUri':
    'Enter an https URL, for example https://verifier.example/support',
  'relyingPartyContact.email': 'Enter an email address, for example support@verifier.example',
  'relyingPartyContact.phone': 'Use 5 to 40 digits, spaces, +, -, ( or )',
};

/** URL fields, which also follow the registrar base URL rule. */
const URL_FIELDS = ['registrarUrl', 'oidcUrl'] as const;

/** The fields under Registrar Credentials, the first part of the form. */
const CREDENTIAL_FIELDS = [
  ...URL_FIELDS,
  'clientId',
  'clientSecret',
  'username',
  'password',
] as const;

/** What to do when the instance's outbound URL policy blocks a URL. */
const POLICY_HINT =
  "Check the URL; if it is correct, ask the operator to allow it in this instance's outbound URL policy.";

/** What to do when the policy check could not resolve the host. */
const DNS_HINT = 'Check the host name, or try again later.';

/** The hint for an outbound URL policy rejection, by its reason. */
function policyHint(message: string): string {
  return message.includes('cannot be resolved') ? DNS_HINT : POLICY_HINT;
}

/**
 * Paths of the issues the outbound URL policy raised, which `getValidationIssues`
 * does not tell apart from other issues.
 */
function policyIssuePaths(error: any): Set<string> {
  const issues = error?.error?.errors ?? error?.errors;
  if (!Array.isArray(issues)) return new Set();
  return new Set(
    issues
      .filter((issue) => issue?.code === 'outbound_url_policy' && Array.isArray(issue.path))
      .map((issue) => issue.path.join('.'))
  );
}

/** The message of a failed save that names no field. */
function requestErrorMessage(error: unknown): string {
  const message = getHttpErrorMessage(error, 'Failed to save configuration');
  // A blocked token endpoint or redirect target has no field to show it.
  return message.includes('outbound URL policy') ? `${message}. ${policyHint(message)}` : message;
}

/** Examples in the message for a URL field whose value is not a full URL. */
const URL_EXAMPLES: Record<string, string> = {
  registrarUrl: 'https://registrar.example.com/api',
  oidcUrl: 'https://auth.example.com/realms/registrar',
};

@Component({
  selector: 'app-registrar',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './registrar.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './registrar.component.scss',
})
export class RegistrarComponent implements OnInit {
  @ViewChild(ConfigOwnershipNoticeComponent)
  private readonly ownershipNotice?: ConfigOwnershipNoticeComponent;
  /** Where focus goes when a retry removes the error card with its focused Retry button. */
  @ViewChild('settingsTitle', { read: ElementRef })
  private readonly settingsTitle?: ElementRef<HTMLElement>;
  /** Takes the focus back after a save that ended with focus nowhere; Safari does not focus a clicked button. */
  @ViewChild('saveButton', { read: ElementRef })
  private readonly saveButton?: ElementRef<HTMLElement>;
  /** Holds the fields; Save focuses the first invalid one. */
  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  /** Delete cannot be used once deleted; focus moves from it to the card title. */
  @ViewChild('deleteButton', { read: ElementRef })
  private readonly deleteButton?: ElementRef<HTMLElement>;
  private readonly injector = inject(Injector);

  configForm: FormGroup;
  config: RegistrarConfig | null = null;
  selectedPreset = '';

  isLoading = true;
  /** Set when the stored configuration could not be loaded; the form stays hidden. */
  loadError = '';
  isSaving = false;
  isDeleting = false;
  showClientSecret = false;
  showPassword = false;

  readonly presets: RegistrarPreset[] = [
    {
      name: 'German Sandbox',
      registrarUrl: 'https://sandbox.eudi-wallet.org/api',
      oidcUrl: 'https://auth.sandbox.eudi-wallet.org/realms/sandbox-registrar',
      clientId: 'swagger',
    },
  ];

  constructor(
    private readonly registrarService: RegistrarService,
    private readonly snackBar: MatSnackBar,
    private readonly fb: FormBuilder,
    private readonly ownership: ConfigOwnershipService
  ) {
    this.configForm = this.fb.group({
      registrarUrl: ['', [Validators.required, httpUrlValidator, registrarBaseUrlValidator]],
      oidcUrl: ['', [Validators.required, httpUrlValidator, registrarBaseUrlValidator]],
      clientId: ['', [Validators.required]],
      clientSecret: [''],
      username: ['', [Validators.required]],
      password: ['', [Validators.required]],
      registrationCertificateDefaults: this.fb.group({
        privacy_policy: [''],
        support_uri: [''],
        intermediary: [''],
      }),
      relyingPartyContact: this.fb.group(
        Object.fromEntries(
          CONTACT_FIELDS.map((field) => [field, ['', contactValidator(CONTACT_RULES[field])]])
        )
      ),
    });
    for (const url of URL_FIELDS) {
      this.configForm.get(url)?.valueChanges.subscribe(() => this.updateCredentialValidators());
    }
  }

  ngOnInit(): void {
    this.loadData();
  }

  async loadData(): Promise<void> {
    const retrying = this.loadError !== '';
    this.isLoading = true;
    this.loadError = '';
    try {
      this.config = await this.registrarService.getConfig();

      if (this.config) {
        const defaults = this.config.registrationCertificateDefaults ?? {};
        const contact = this.config.relyingPartyContact ?? {};
        this.configForm.patchValue({
          registrarUrl: this.config.registrarUrl,
          oidcUrl: this.config.oidcUrl,
          clientId: this.config.clientId,
          clientSecret: '', // Never returned; user must enter a new one to change it
          username: this.config.username,
          password: '', // Password is never returned; user must enter new one to change it
          registrationCertificateDefaults: Object.fromEntries(
            FORM_DEFAULTS.map((key) => [
              key,
              typeof defaults[key] === 'string' ? defaults[key] : '',
            ])
          ),
          relyingPartyContact: Object.fromEntries(
            CONTACT_FIELDS.map((field) => [field, contact[field] ?? ''])
          ),
        });
        this.updateCredentialValidators();
        // A URL stored before the base URL rule, or a contact value the
        // client rule rejects, shows its error right away.
        for (const control of [
          ...URL_FIELDS.map((field) => this.configForm.get(field)),
          ...CONTACT_FIELDS.map((field) => this.configForm.get(['relyingPartyContact', field])),
        ]) {
          if (control?.invalid) control.markAsTouched();
        }
      }
    } catch (error) {
      // Without the stored configuration the form would look like a new one,
      // and saving it would replace the stored configuration and remove its
      // client secret.
      console.error('Error loading registrar data:', error);
      this.loadError = getHttpErrorMessage(
        error,
        'The registrar configuration could not be loaded'
      );
    } finally {
      this.isLoading = false;
    }
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.settingsTitle?.nativeElement);
    }
  }

  /**
   * The backend keeps the stored password and client secret only while the
   * registrar URL and OIDC URL stay the same. A changed URL therefore
   * replaces the whole configuration.
   */
  get urlsChanged(): boolean {
    // The group value lags behind while a control emits valueChanges.
    const { registrarUrl, oidcUrl } = this.configForm.getRawValue();
    // The backend stores the URLs trimmed.
    return (
      this.config !== null &&
      (`${registrarUrl ?? ''}`.trim() !== this.config.registrarUrl ||
        `${oidcUrl ?? ''}`.trim() !== this.config.oidcUrl)
    );
  }

  /** Require the password unless the stored one is kept. */
  private updateCredentialValidators(): void {
    const password = this.configForm.get('password');
    password?.setValidators(
      !this.config?.hasPassword || this.urlsChanged ? [Validators.required] : []
    );
    password?.updateValueAndValidity({ emitEvent: false });
  }

  /**
   * Whether the input itself is invalid. A rejection by the backend does not
   * count: its cause may have been fixed outside the form, for example in the
   * outbound URL policy, so saving again is allowed and checks anew.
   */
  get hasInvalidInput(): boolean {
    return this.fieldControls().some((control) =>
      Object.keys(control.errors ?? {}).some((key) => key !== 'server')
    );
  }

  /** The controls with own validation: top-level fields and contact fields. */
  private fieldControls(): AbstractControl[] {
    return [
      ...Object.values(this.configForm.controls),
      ...CONTACT_FIELDS.map((field) => this.configForm.get(['relyingPartyContact', field])!),
    ];
  }

  /** Save stays focusable while another change runs, so its tooltip says why it waits. */
  get saveTooltip(): string {
    return this.isSaving || this.isDeleting ? WAIT_FOR_CHANGE : '';
  }

  async saveConfig(): Promise<void> {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    if (this.isSaving || this.isDeleting) return;
    if (this.hasInvalidInput) {
      const form = this.configForm;
      showFieldsToFix(form, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
        sections: [
          {
            name: 'Registrar Credentials',
            controls: CREDENTIAL_FIELDS.map((field) => form.get(field)),
          },
          { name: 'Relying Party Contact', controls: [form.get('relyingPartyContact')] },
          {
            name: 'Registration Certificate Defaults',
            controls: [form.get('registrationCertificateDefaults')],
          },
        ],
      });
      return;
    }
    // Drop the previous backend rejections; the backend checks again.
    for (const control of this.fieldControls()) {
      if (control.hasError('server')) control.updateValueAndValidity({ emitEvent: false });
    }

    const formValue = this.configForm.value;
    const isUpdate = this.config !== null;

    // Password is required for new config
    if (!isUpdate && !formValue.password) {
      this.snackBar.open('Password is required for new configuration', 'Close', { duration: 3000 });
      return;
    }

    this.isSaving = true;
    try {
      const configRequest: RegistrarConfigRequest = {
        registrarUrl: formValue.registrarUrl.trim(),
        oidcUrl: formValue.oidcUrl.trim(),
        clientId: formValue.clientId,
        clientSecret: formValue.clientSecret || undefined,
        username: formValue.username,
        registrationCertificateDefaults: this.mergeCertificateDefaults(
          formValue.registrationCertificateDefaults ?? {}
        ),
        relyingPartyContact: this.contactFromForm(formValue.relyingPartyContact ?? {}),
      };

      // Only include password if user entered one (for updates) or always for new config
      if (formValue.password) {
        configRequest.password = formValue.password;
      }

      if (isUpdate && !this.urlsChanged) {
        // Use PATCH for updates. The URLs are unchanged, so leave them out:
        // URLs changed elsewhere since loading would otherwise be rejected.
        // The backend checks the credentials again whenever the request
        // carries one, so an unchanged client ID or username stays out too.
        const changes: Partial<RegistrarConfigRequest> = { ...configRequest };
        delete changes.registrarUrl;
        delete changes.oidcUrl;
        if (changes.clientId === this.config?.clientId) delete changes.clientId;
        if (changes.username === this.config?.username) delete changes.username;
        this.config = await this.registrarService.updateConfig(changes);
      } else {
        // Use POST for a new config or new URLs: it replaces the stored
        // credentials, and an empty client secret removes the stored one
        this.config = await this.registrarService.saveConfig(configRequest);
      }
      // The secrets are stored now. Leaving them in the form would send them
      // with the next update, which checks the credentials again.
      this.configForm.patchValue({ password: '', clientSecret: '' });
      this.showPassword = false;
      this.showClientSecret = false;
      this.updateCredentialValidators();
      this.snackBar.open('Configuration saved successfully', 'Close', { duration: 3000 });
    } catch (error: any) {
      console.error('Error saving config:', error);
      // Long enough to read a message that names a URL for the operator.
      this.snackBar.open(this.saveErrorMessage(error), 'Close', { duration: 12000 });
    } finally {
      this.isSaving = false;
      focusAfterRenderIfLost(this.injector, () => this.saveButton?.nativeElement);
    }
  }

  /**
   * Shows each field the backend rejected under that field, until it is
   * edited, and returns the message for the snackbar, which lists the
   * remaining issues.
   */
  private saveErrorMessage(error: any): string {
    const issues = getValidationIssues(error);
    if (!issues.length) return requestErrorMessage(error);
    const policyPaths = policyIssuePaths(error);
    const others: string[] = [];
    let hint: string | undefined;
    for (const { path, message } of issues) {
      // A policy rejection is not always fixed by editing the field, so it
      // says what to check and who can change the policy.
      const policy = policyPaths.has(path) ? policyHint(message) : undefined;
      hint = policy ?? hint;
      const text = policy ? `${message}. ${policy}` : message;
      if (!this.showAtField(path, text)) others.push(path ? `${path}: ${text}` : text);
    }
    const parts = ['Failed to save configuration.'];
    if (others.length < issues.length) parts.push(hint ?? 'Check the highlighted fields.');
    if (others.length) parts.push(others.join('; '));
    return parts.join(' ');
  }

  /**
   * Puts a backend issue under its form field, until the field is edited.
   * @returns false when the form has no field for `path`
   */
  private showAtField(path: string, text: string): boolean {
    const control = path in FIELD_LABELS ? this.configForm.get(path) : null;
    if (!control) return false;
    control.setErrors({ ...control.errors, server: text });
    control.markAsTouched();
    return true;
  }

  /** Message under a form field for its current error. */
  fieldError(name: string): string {
    const control = this.configForm.get(name);
    if (control?.hasError('server')) return control.getError('server');
    if (control?.hasError('url')) return `Enter a full URL, for example ${URL_EXAMPLES[name]}`;
    if (control?.hasError('registrarBaseUrl'))
      return 'Enter an http(s) URL without query, fragment or credentials';
    if (control?.hasError('pattern')) return CONTACT_PATTERN_MESSAGES[name];
    if (name === 'password' && this.urlsChanged)
      return 'The URL changed. Enter the password again.';
    return `${FIELD_LABELS[name]} is required`;
  }

  /**
   * The contact to send: the filled fields, or null when all are empty, which
   * removes the stored contact. PATCH and POST replace it as a whole.
   */
  private contactFromForm(
    fields: Partial<Record<(typeof CONTACT_FIELDS)[number], string | null>>
  ): RelyingPartyContact | null {
    const contact: RelyingPartyContact = {};
    for (const field of CONTACT_FIELDS) {
      const value = fields[field]?.trim();
      if (value) contact[field] = value;
    }
    return Object.keys(contact).length ? contact : null;
  }

  /**
   * Both PATCH and POST replace the stored defaults as a whole. Start from the
   * loaded ones so keys the form does not show survive, and apply the form
   * fields on top: a filled field sets its key, a cleared one removes it.
   */
  private mergeCertificateDefaults(
    fields: Partial<Record<(typeof FORM_DEFAULTS)[number], string | null>>
  ): Record<string, unknown> | null {
    const defaults: Record<string, unknown> = { ...this.config?.registrationCertificateDefaults };
    for (const key of FORM_DEFAULTS) {
      const value = fields[key]?.trim();
      if (value) {
        defaults[key] = value;
      } else if (typeof defaults[key] === 'string') {
        // The form showed this value and it was cleared. A value of another
        // type was never shown, so it stays.
        delete defaults[key];
      }
    }
    return Object.keys(defaults).length ? defaults : null;
  }

  /**
   * Tooltip of Delete. The button stays focusable while it cannot be used, so
   * the tooltip says why, and screen readers read it as its description.
   */
  get deleteTooltip(): string {
    if (this.isSaving || this.isDeleting) return WAIT_FOR_CHANGE;
    if (!this.hasConfig) return 'Nothing to delete: no registrar configuration is stored';
    return 'Delete the registrar configuration';
  }

  async deleteConfig(): Promise<void> {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    if (!this.hasConfig || this.isSaving || this.isDeleting) return;
    // Set before the ownership lookup, a request, so a second click cannot ask twice.
    this.isDeleting = true;
    try {
      // Advisory only: without the ownership the question leaves the restore out.
      const ownership = await this.ownership
        .get('RegistrarConfig', 'registrar')
        .catch(() => undefined);
      if (!confirm(this.deleteQuestion(ownership))) {
        return;
      }

      await this.registrarService.deleteConfig();
      this.config = null;
      this.configForm.reset();
      this.selectedPreset = '';
      // Delete stays focusable but unusable now that nothing is stored.
      focusAfterRenderIfLost(
        this.injector,
        () => this.settingsTitle?.nativeElement,
        () => this.deleteButton?.nativeElement
      );
      // The backend removed the ownership record with the configuration.
      void this.ownershipNotice?.refresh();
      this.snackBar.open('Configuration deleted', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error deleting config:', error);
      openErrorSnackBar(
        this.snackBar,
        getHttpErrorMessage(error, 'Failed to delete configuration')
      );
    } finally {
      this.isDeleting = false;
    }
  }

  /**
   * What Delete removes, and what stops working until the registrar is
   * configured again. A configuration detached from a folder has no ownership
   * record once deleted, so a startup import from that folder creates it again.
   */
  private deleteQuestion(ownership?: ConfigResourceOwnership): string {
    const secrets = this.config?.hasClientSecret ? 'password, client secret' : 'password';
    const restore =
      ownership?.ownership === 'detached'
        ? `A startup import from ${ownership.source || 'its configuration folder'} can restore it.`
        : 'This cannot be undone.';
    return (
      `Delete the registrar configuration? Its URLs, account, stored ${secrets}, ` +
      'relying party contact and registration certificate defaults are removed. Until the registrar is configured again, ' +
      'presentation requests are sent without registration certificates, and no access or ' +
      `registration certificates can be requested. ${restore}`
    );
  }

  get hasConfig(): boolean {
    return this.config !== null;
  }

  toggleClientSecretVisibility(): void {
    this.showClientSecret = !this.showClientSecret;
  }

  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  applyPreset(presetName: string): void {
    const preset = this.presets.find((p) => p.name === presetName);
    if (preset) {
      this.configForm.patchValue({
        registrarUrl: preset.registrarUrl,
        oidcUrl: preset.oidcUrl,
        clientId: preset.clientId,
        clientSecret: preset.clientSecret || '',
      });
      this.snackBar.open(
        `Applied "${preset.name}" preset. Please enter your credentials.`,
        'Close',
        {
          duration: 3000,
        }
      );
    }
  }
}
