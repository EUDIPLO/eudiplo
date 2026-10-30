import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioButton, MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { merge } from 'rxjs';
import { readCertificateFiles } from '../certificate-files';
import { KeyChainService } from '../key-chain.service';
import {
  accessKeyEnrollmentFailure,
  RegistrarConfig,
  RegistrarService,
} from '../../registrar/registrar.service';
import { KeyChainCreateDto, KeyChainImportDto, KmsProviderInfoDto } from '@eudiplo/sdk-core';
import { asSentence, getApiErrorMessage, getHttpErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { JwtService } from '../../services/jwt.service';
import { focusIfFocusWasLost } from '../../common/focus-if-lost.util';

export type KeyUsageSelection =
  'attestation' | 'statusList' | 'access' | 'accessToken' | 'trustList' | 'federation';
export type KeyChainTypeSelection = 'internalChain' | 'externalCaChain' | 'standalone';
export type AccessSourceSelection = 'selfSigned' | 'registrar' | 'external';
export type SigningAlgorithm = NonNullable<KeyChainCreateDto['alg']>;

/** Signing algorithms with the curve each one selects. */
const SIGNING_ALGORITHM_LABELS: Record<SigningAlgorithm, string> = {
  ES256: 'ES256 (ECDSA P-256)',
  ES384: 'ES384 (ECDSA P-384)',
  ES512: 'ES512 (ECDSA P-521)',
};

/** Whether the external certificate comes with its key, or is requested for a key EUDIPLO creates. */
export type ExternalCertificateSource = 'import' | 'csr';

/** Why a registrar enrollment was refused, shown next to Create & Enroll. */
export interface EnrollmentError {
  message: string;
  /** False when the registrar configuration is not the cause, for example a missing role. */
  offerRegistrar: boolean;
  /** A key EUDIPLO kept although the enrollment failed, offered for deletion. */
  keptKeyId?: string;
  /** True when the outcome is unknown and the user should check Keys. */
  offerKeys?: boolean;
}

@Component({
  selector: 'app-key-create-wizard',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatSnackBarModule,
    MatStepperModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
  ],
  templateUrl: './key-create-wizard.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './key-create-wizard.component.scss',
})
export class KeyCreateWizardComponent implements OnInit, OnDestroy {
  @ViewChild('stepper') stepper!: MatStepper;

  /**
   * The Create & Enroll button is replaced while the enrollment runs, so focus
   * falls back to the page; it moves to the error that appears afterwards.
   */
  @ViewChild('enrollmentErrorBox') set enrollmentErrorBox(
    box: ElementRef<HTMLElement> | undefined
  ) {
    focusIfFocusWasLost(box?.nativeElement);
  }

  @ViewChild('registrarRetry', { read: ElementRef })
  private readonly registrarRetry?: ElementRef<HTMLButtonElement>;
  @ViewChildren(MatRadioButton) private readonly radioButtons?: QueryList<MatRadioButton>;

  /** Set when the user left the wizard, so a running enrollment does not pull them back. */
  private destroyed = false;

  // Form groups for each step
  usageForm: FormGroup;
  caSourceForm: FormGroup;
  accessSourceForm: FormGroup;
  configForm: FormGroup;

  isSubmitting = false;
  isCheckingRegistrar = false;
  isLoadingKmsProviders = false;
  registrarConfig: RegistrarConfig | null = null;
  registrarConfigChecked = false;
  /** Why the registrar configuration could not be read; null when it was read or is missing. */
  registrarConfigError: string | null = null;
  enrollmentError: EnrollmentError | null = null;
  availableKmsProviders: KmsProviderInfoDto[] = [];
  defaultKmsProvider = 'db';

  // Usage options with descriptions
  usageOptions = [
    {
      value: 'attestation' as KeyUsageSelection,
      label: 'Credential Signing (Attestation)',
      icon: 'verified_user',
      description: 'Create a key for signing verifiable credentials (SD-JWT VC, mDOC).',
      hint: 'Create one key per credential type (e.g., diplomas, membership cards)',
    },
    {
      value: 'statusList' as KeyUsageSelection,
      label: 'Status List Signing',
      icon: 'playlist_add_check',
      description: 'Create a key for signing revocation/suspension status lists.',
      hint: 'Create one per credential type to manage its lifecycle separately',
    },
    {
      value: 'access' as KeyUsageSelection,
      label: 'Access Certificate',
      icon: 'badge',
      description: 'Prove your identity as an issuer/verifier to EUDI wallets.',
      hint: 'Self-signed for development or obtained through registrar enrollment',
    },
    {
      value: 'accessToken' as KeyUsageSelection,
      label: 'Access Token Signing',
      icon: 'key',
      description:
        'Create a key that signs the OAuth access tokens of your authorization servers. EUDIPLO creates one when the tenant has none.',
      hint: 'Choose it as the signing key of an authorization server; no certificate is involved',
    },
    {
      value: 'trustList' as KeyUsageSelection,
      label: 'Trust List Signing',
      icon: 'shield',
      description: 'Create a key for signing trust lists.',
      hint: 'For trust framework operators only',
    },
    {
      value: 'federation' as KeyUsageSelection,
      label: 'OpenID Federation Entity Key',
      icon: 'hub',
      description:
        'Create a key that signs the entity configuration of your OpenID Federation entity.',
      hint: 'Only needed when this tenant takes part in an OpenID Federation',
    },
  ];

  // Key chain type options (shown for attestation and status list keys)
  keyChainTypeOptions = [
    {
      value: 'internalChain' as KeyChainTypeSelection,
      label: 'Create Key Chain (Recommended)',
      icon: 'account_tree',
      description: 'Create a key chain with embedded root CA and a signing key under it.',
      hint: 'Recommended for production. Verifiers trust its root CA, which stays the same when the signing key rotates.',
      features: [
        'Optional rotation (on by default)',
        'Embedded root CA',
        'Full lifecycle management',
      ],
    },
    {
      value: 'standalone' as KeyChainTypeSelection,
      label: 'Standalone Key',
      icon: 'key',
      description: 'Create a self-signed standalone key.',
      hint: 'For simple setups or external PKI integration.',
      features: ['Self-signed certificate', 'Manual certificate management', 'Simple setup'],
    },
    {
      value: 'externalCaChain' as KeyChainTypeSelection,
      label: 'External CA Chain',
      icon: 'verified',
      description: 'Import your CA key and certificate to issue the signing certificate.',
      hint: 'EUDIPLO creates the signing key under your CA and can rotate it, while your CA certificate stays the trust anchor.',
      features: [
        'External CA certificate',
        'Optional rotation (on by default)',
        'CA key remains managed',
      ],
    },
  ];

  // Access source options (shown for access keys)
  accessSourceOptions = [
    {
      value: 'selfSigned' as AccessSourceSelection,
      label: 'Self-Signed Certificate',
      icon: 'key',
      description: 'Create a self-signed access certificate for development or testing.',
      hint: 'Quick setup, no registrar required. Suitable for dev/test environments.',
    },
    {
      value: 'registrar' as AccessSourceSelection,
      label: 'Registrar Enrollment',
      icon: 'verified',
      description: 'Obtain a certificate through your registrar.',
      hint: 'Required for production. Provides a trusted certificate chain.',
    },
    {
      value: 'external' as AccessSourceSelection,
      label: 'External Certificate',
      icon: 'upload_file',
      description: 'Use a certificate issued by an external CA or PKI.',
      hint: 'Import a key with its certificate chain, or create the key here and request its certificate from your CA with a CSR.',
    },
  ];

  constructor(
    private readonly fb: FormBuilder,
    private readonly keyChainService: KeyChainService,
    private readonly registrarService: RegistrarService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar,
    private readonly jwtService: JwtService
  ) {
    // Step 1: Usage selection
    this.usageForm = this.fb.group({
      usage: ['', Validators.required],
    });

    // Step 2a: Key chain type selection (internal chain vs standalone, for attestation and status lists)
    this.caSourceForm = this.fb.group({
      keyChainType: ['internalChain', Validators.required],
    });

    // Step 2b: Access source selection (self-signed vs registrar)
    this.accessSourceForm = this.fb.group({
      accessSource: ['selfSigned', Validators.required],
    });

    // Step 3: Configuration
    this.configForm = this.fb.group({
      // Description for the key chain
      description: [''],
      // KMS provider for key storage/signing
      kmsProvider: ['db', Validators.required],
      // Signing algorithm; starts at the provider's default
      alg: ['ES256' as SigningAlgorithm, Validators.required],
      // Rotation settings (only for internal and external CA chains)
      rotationEnabled: [true],
      rotationIntervalDays: [30, [Validators.required, Validators.min(1), Validators.max(3650)]],
      certValidityDays: [365, [Validators.required, Validators.min(1), Validators.max(3650)]],
      externalPrivateKey: [''],
      externalCertificate: [''],
      useExternalCertificate: [false],
      externalCertificateSource: ['import' as ExternalCertificateSource],
    });

    // Fields of the hidden Rotation Policy card must not block the form.
    this.usageForm.valueChanges.subscribe(() => this.syncRotationControls());
    this.caSourceForm.valueChanges.subscribe(() => this.syncRotationControls());
    this.configForm
      .get('rotationEnabled')!
      .valueChanges.subscribe(() => this.syncRotationControls());
    this.syncRotationControls();

    // Each provider offers its own algorithms: keep the chosen one if the new
    // provider offers it, else use the provider's default.
    this.configForm.get('kmsProvider')!.valueChanges.subscribe((provider: string) => {
      const alg = this.configForm.value.alg as SigningAlgorithm;
      if (!this.algorithmsOf(provider).includes(alg)) {
        this.configForm.patchValue(
          { alg: this.defaultAlgorithmOf(provider) },
          { emitEvent: false }
        );
      }
    });

    // A refusal belongs to the registrar enrollment it reports.
    merge(this.usageForm.valueChanges, this.accessSourceForm.valueChanges).subscribe(() => {
      this.enrollmentError = null;
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
  }

  /** Enables the interval and validity fields only while the Rotation Policy card shows them. */
  private syncRotationControls(): void {
    const toggle = (name: string, enabled: boolean) => {
      const control = this.configForm.get(name)!;
      if (enabled) control.enable({ emitEvent: false });
      else control.disable({ emitEvent: false });
    };
    toggle('certValidityDays', this.isInternalChain);
    toggle('rotationIntervalDays', this.rotationEnabled);
  }

  ngOnInit(): void {
    // Links that need one kind of key, such as the issuer settings, preselect its usage.
    const requestedUsage = this.route.snapshot.queryParamMap.get('usage');
    if (this.usageOptions.some((option) => option.value === requestedUsage)) {
      this.usageForm.get('usage')!.setValue(requestedUsage);
    }
    // Pre-check registrar config so we can show status quickly
    // checkRegistrarConfig handles its own errors.
    if (this.canUseRegistrar) void this.checkRegistrarConfig();
    this.loadKmsProviders();
  }

  /**
   * Load available KMS providers and preselect backend default provider.
   */
  async loadKmsProviders(): Promise<void> {
    this.isLoadingKmsProviders = true;
    try {
      const response = await this.keyChainService.getProviders();
      this.availableKmsProviders = response.providers || [];
      this.defaultKmsProvider = response.default || 'db';

      const requestedProvider = this.route.snapshot.queryParamMap.get('kmsProvider');
      const requestedIsValid =
        requestedProvider != null &&
        this.availableKmsProviders.some((p) => p.name === requestedProvider);

      const selected =
        (requestedIsValid ? requestedProvider : null) ||
        this.availableKmsProviders.find((p) => p.name === this.defaultKmsProvider)?.name ||
        this.availableKmsProviders[0]?.name ||
        'db';

      this.configForm.patchValue({ kmsProvider: selected });
      this.configForm.patchValue({ alg: this.defaultAlgorithmOf(selected) }, { emitEvent: false });
    } catch (error) {
      console.error('Failed to load KMS providers:', error);
      this.availableKmsProviders = [];
      this.defaultKmsProvider = 'db';
      this.configForm.patchValue({ kmsProvider: 'db' });
      openErrorSnackBar(
        this.snackBar,
        `${asSentence(getApiErrorMessage(error, 'Failed to load KMS providers'))} Falling back to db with ES256.`
      );
    } finally {
      this.isLoadingKmsProviders = false;
    }
  }

  /**
   * Check if registrar credentials are configured.
   */
  async checkRegistrarConfig(): Promise<void> {
    if (this.isCheckingRegistrar) return;
    this.isCheckingRegistrar = true;
    try {
      this.registrarConfig = await this.registrarService.getConfig();
      this.registrarConfigError = null;
    } catch (error) {
      // getConfig answers null for a missing configuration, so this is a failed load.
      this.registrarConfig = null;
      this.registrarConfigError = getHttpErrorMessage(
        error,
        'Could not check the registrar configuration'
      );
    } finally {
      this.isCheckingRegistrar = false;
      this.registrarConfigChecked = true;
    }
  }

  /**
   * Reads the registrar configuration again. The Retry button stays while it
   * runs and goes away once the configuration is read, so focus then moves
   * from it to the selected certificate source, where a radio group takes it.
   */
  async retryRegistrarCheck(): Promise<void> {
    await this.checkRegistrarConfig();
    const retryHadFocus = document.activeElement === this.registrarRetry?.nativeElement;
    if (!this.registrarConfigError && retryHadFocus) {
      this.radioButtons?.find((radio) => radio.value === this.selectedAccessSource)?.focus();
    }
  }

  /**
   * Check if registrar is configured and ready to use.
   */
  get hasRegistrarConfig(): boolean {
    return this.registrarConfig !== null;
  }

  /** Reading the registrar configuration and enrolling through it need registrar:manage. */
  get canUseRegistrar(): boolean {
    return this.jwtService.hasRole('registrar:manage');
  }

  isAccessSourceAvailable(source: AccessSourceSelection): boolean {
    return source !== 'registrar' || this.canUseRegistrar;
  }

  get selectedUsage(): KeyUsageSelection | null {
    return this.usageForm.get('usage')?.value || null;
  }

  get selectedKeyChainType(): KeyChainTypeSelection {
    return this.caSourceForm.get('keyChainType')?.value || 'internalChain';
  }

  get selectedAccessSource(): AccessSourceSelection {
    return this.accessSourceForm.get('accessSource')?.value || 'selfSigned';
  }

  get showKeyChainTypeStep(): boolean {
    // Attestation and status list keys choose their key chain type, and with it rotation
    return this.selectedUsage === 'attestation' || this.selectedUsage === 'statusList';
  }

  get showAccessSourceStep(): boolean {
    return this.selectedUsage === 'access';
  }

  get showConfigStep(): boolean {
    // Access certificates via registrar are created in this wizard if registrar is configured
    if (this.selectedUsage === 'access' && this.selectedAccessSource === 'registrar') {
      return this.hasRegistrarConfig;
    }
    return !!this.selectedUsage;
  }

  get isInternalChain(): boolean {
    return (
      this.showKeyChainTypeStep &&
      (this.selectedKeyChainType === 'internalChain' ||
        this.selectedKeyChainType === 'externalCaChain')
    );
  }

  get isExternalCaChain(): boolean {
    return this.showKeyChainTypeStep && this.selectedKeyChainType === 'externalCaChain';
  }

  get rotationEnabled(): boolean {
    // Rotation is optional for internal and external CA chains
    return this.isInternalChain && !!this.configForm.value.rotationEnabled;
  }

  /** Algorithms a provider offers for new key chains; ES256 while providers are unknown. */
  private algorithmsOf(providerName: string): SigningAlgorithm[] {
    const provider = this.availableKmsProviders.find((p) => p.name === providerName);
    return (provider?.capabilities.supportedAlgs ?? ['ES256']).filter(
      (alg): alg is SigningAlgorithm => alg in SIGNING_ALGORITHM_LABELS
    );
  }

  /** A provider's default algorithm, or the first it offers. */
  private defaultAlgorithmOf(providerName: string): SigningAlgorithm {
    const offered = this.algorithmsOf(providerName);
    const preferred = this.availableKmsProviders.find((p) => p.name === providerName)?.capabilities
      .defaultAlg;
    return offered.find((alg) => alg === preferred) ?? offered[0] ?? 'ES256';
  }

  /** Algorithms the selected provider offers for new key chains. */
  get algorithmOptions(): { value: SigningAlgorithm; label: string }[] {
    return this.algorithmsOf(this.configForm.value.kmsProvider).map((value) => ({
      value,
      label: SIGNING_ALGORITHM_LABELS[value],
    }));
  }

  /**
   * True when EUDIPLO generates the key, so the user picks its algorithm. An
   * imported key brings its own curve, and registrar enrollment uses the
   * provider's default.
   */
  get showAlgorithm(): boolean {
    return (
      !this.importsExternalKey &&
      !(this.selectedUsage === 'access' && this.selectedAccessSource === 'registrar')
    );
  }

  get isExternalCertificate(): boolean {
    return (
      (this.selectedUsage === 'access' && this.selectedAccessSource === 'external') ||
      this.isExternalCaChain ||
      (!!this.selectedUsage &&
        this.selectedUsage !== 'access' &&
        // Federation and access token keys are published as JWKs; they need no certificate.
        this.selectedUsage !== 'federation' &&
        this.selectedUsage !== 'accessToken' &&
        !this.isInternalChain &&
        this.configForm.value.useExternalCertificate)
    );
  }

  /**
   * The key is created in EUDIPLO and its certificate requested with a CSR
   * on the key's page, instead of importing a key with its certificate.
   * An External CA Chain always imports the CA key.
   */
  get requestsCertificate(): boolean {
    return (
      this.isExternalCertificate &&
      !this.isExternalCaChain &&
      this.configForm.value.externalCertificateSource === 'csr'
    );
  }

  /** The key and certificate chain are pasted or loaded into the form. */
  get importsExternalKey(): boolean {
    return this.isExternalCertificate && !this.requestsCertificate;
  }

  get externalCertificateFormValid(): boolean {
    return (
      !this.importsExternalKey ||
      (!!this.configForm.value.externalPrivateKey?.trim() &&
        !!this.configForm.value.externalCertificate?.trim())
    );
  }

  /**
   * Get the appropriate next step label based on current selection.
   */
  getNextStepLabel(): string {
    if (!this.selectedUsage) return 'Next';
    if (this.showKeyChainTypeStep || this.showAccessSourceStep) return 'Next';
    return 'Configure Key';
  }

  /**
   * Handle usage selection and advance to next step.
   */
  onUsageNext(): void {
    this.stepper.next();
  }

  /**
   * Handle access source selection and advance to next step.
   * For registrar enrollment, we stay in the wizard if credentials are configured.
   */
  onAccessSourceNext(): void {
    if (this.selectedAccessSource === 'registrar') {
      if (!this.canUseRegistrar) {
        this.snackBar.open(
          'Enrolling through the registrar needs the registrar:manage role',
          'Close',
          {
            duration: 5000,
          }
        );
        return;
      }
      if (!this.hasRegistrarConfig) {
        // Config not yet set - user can go to registrar page via UI link
        // but we don't force navigation automatically
        this.snackBar
          .open('Please configure registrar credentials first', 'Go to Registrar', {
            duration: 5000,
          })
          .onAction()
          .subscribe(() => {
            this.router.navigate(['/registrar']);
          });
        return;
      }
    }
    this.stepper.next();
  }

  /**
   * Create the key chain based on wizard selections.
   * For registrar enrollment, creates the key then requests a certificate.
   */
  async createKey(): Promise<void> {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    this.enrollmentError = null;

    try {
      const usage = this.selectedUsage!;
      const description = this.configForm.value.description?.trim();
      const isRegistrarEnrollment = usage === 'access' && this.selectedAccessSource === 'registrar';

      if (this.importsExternalKey) {
        await this.importExternalKey(usage, description);
        return;
      }

      if (isRegistrarEnrollment) {
        await this.enrollWithRegistrar(description);
        return;
      }

      // Build the KeyChainCreateDto
      const createDto: KeyChainCreateDto = {
        usageType: usage,
        type: usage === 'access' || !this.isInternalChain ? 'standalone' : 'internalChain',
        description: description || this.getDefaultDescription(),
        kmsProvider: this.configForm.value.kmsProvider || this.defaultKmsProvider || 'db',
        alg: this.configForm.value.alg || undefined,
        rotationPolicy: this.rotationPolicy(),
      };

      const result = await this.keyChainService.create(createDto);

      // Show success message with next steps
      if (this.requestsCertificate) {
        this.snackBar.open(
          'Key created. Create its CSR on this page and store the certificate your CA issues.',
          'Close',
          { duration: 8000 }
        );
      } else {
        this.showSuccessMessage(usage);
      }
      this.router.navigate(
        ['/keys', result.id],
        this.requestsCertificate ? { queryParams: { certificate: 'request' } } : undefined
      );
    } catch (error) {
      console.error('Error creating key chain:', error);
      const fallback = this.importsExternalKey
        ? 'Failed to import key chain'
        : 'Failed to create key chain';
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, fallback));
    } finally {
      this.isSubmitting = false;
    }
  }

  /** Imports the pasted key and certificate chain and opens the imported key chain. */
  private async importExternalKey(usage: KeyUsageSelection, description?: string): Promise<void> {
    const importDto: KeyChainImportDto = {
      ...this.parseExternalPrivateKey(),
      usageType: usage,
      // Without type, the backend guesses from rotationPolicy and the certificate.
      type: this.isExternalCaChain ? 'internalChain' : 'standalone',
      description: description || this.getDefaultDescription(),
      kmsProvider: this.configForm.value.kmsProvider || this.defaultKmsProvider || 'db',
      crt: this.parseCertificateChain(this.configForm.value.externalCertificate),
      // certValidityDays also sets the validity of the first signing certificate.
      rotationPolicy: this.isExternalCaChain ? this.rotationPolicy() : undefined,
    };
    const result = await this.keyChainService.import(importDto);
    this.snackBar.open(
      this.isExternalCaChain
        ? 'CA imported and signing key created.'
        : 'Key and certificate imported.',
      'Close',
      { duration: 5000 }
    );
    this.router.navigate(['/keys', result.id]);
  }

  /** The rotation policy of the Rotation Policy card; the interval only with rotation. */
  private rotationPolicy(): NonNullable<KeyChainCreateDto['rotationPolicy']> {
    return {
      enabled: this.rotationEnabled,
      intervalDays: this.rotationEnabled ? this.configForm.value.rotationIntervalDays : undefined,
      certValidityDays: this.configForm.value.certValidityDays,
    };
  }

  /**
   * Creates an access key enrolled at the registrar in one request. When the
   * enrollment fails, EUDIPLO deletes the new key itself, so the tenant is not
   * left with a self-signed access key. A refusal is shown next to Create &
   * Enroll, so the user can check the registrar configuration and try again.
   * A server error carries the backend's reason, which names a key EUDIPLO
   * could not delete. Without an answer the outcome is unknown, so the message
   * says how to tell an enrolled key from a self-signed one. A user who left
   * the wizard meanwhile gets the outcome in a snackbar and stays where they are.
   */
  private async enrollWithRegistrar(description?: string): Promise<void> {
    let keyId: string;
    try {
      ({ certId: keyId } = await this.registrarService.createAccessKeyChain({
        description: description || this.getDefaultDescription(),
        kmsProvider: this.configForm.value.kmsProvider || this.defaultKmsProvider || 'db',
      }));
    } catch (error) {
      console.error('Error enrolling certificate:', error);
      this.showEnrollmentError(this.enrollmentErrorFor(error));
      return;
    }
    this.snackBar
      .open('Access certificate enrolled via registrar successfully!', 'View Key', {
        duration: 5000,
      })
      .onAction()
      .subscribe(() => this.router.navigate(['/keys', keyId]));
    if (!this.destroyed) this.router.navigate(['/keys', keyId]);
  }

  /** What to tell the user about a failed {@link enrollWithRegistrar}. */
  private enrollmentErrorFor(error: unknown): EnrollmentError {
    // Names an unreachable backend separately from a registrar failure.
    const reason = asSentence(
      getHttpErrorMessage(error, 'Failed to enroll certificate from registrar')
    );
    const failure = accessKeyEnrollmentFailure(error);
    switch (failure.kind) {
      case 'role':
        return {
          message:
            'Enrolling through the registrar needs the registrar:manage role. No key was kept.',
          offerRegistrar: false,
        };
      case 'registrar':
        return {
          message: `${reason} No key was kept. Check the registrar configuration and try again.`,
          offerRegistrar: true,
        };
      case 'refused':
      case 'failed':
        return { message: `${reason} No key was kept.`, offerRegistrar: false };
      case 'keyLeft':
        return {
          message:
            `${reason} The new key has only its self-signed certificate: open it and ` +
            'select Enroll with Registrar on its Active Certificate, or delete it.',
          offerRegistrar: false,
          keptKeyId: failure.keyId,
        };
      case 'unknown':
        return {
          message:
            `${reason} EUDIPLO may still have created the key. If Keys lists a new access key, open it: ` +
            'a different Issuer than Subject in its Active Certificate means it is enrolled; ' +
            'the same Issuer as Subject means it is self-signed: select Enroll with Registrar ' +
            'on that certificate, or delete the key.',
          offerRegistrar: false,
          offerKeys: true,
        };
    }
  }

  private showEnrollmentError(enrollmentError: EnrollmentError): void {
    if (this.destroyed) {
      openErrorSnackBar(this.snackBar, enrollmentError.message);
    } else {
      this.enrollmentError = enrollmentError;
    }
  }

  private showSuccessMessage(usage: KeyUsageSelection): void {
    if (usage === 'attestation') {
      if (this.isInternalChain) {
        this.snackBar
          .open(
            'Key chain created with embedded root CA! Next: Create a status list key.',
            'Create Status List Key',
            { duration: 8000 }
          )
          .onAction()
          .subscribe(() => {
            this.router.navigate(['/keys/create'], { queryParams: { usage: 'statusList' } });
          });
      } else {
        this.snackBar.open(
          'Standalone key created! You can configure certificates in the key details.',
          'View Key',
          { duration: 5000 }
        );
      }
    } else if (usage === 'statusList') {
      this.snackBar.open(
        'Status list key created! Your credential type setup is complete.',
        'View Key',
        { duration: 5000 }
      );
    } else if (usage === 'access') {
      this.snackBar.open(
        'Access certificate created! You can use this for wallet communication.',
        'View Key',
        { duration: 5000 }
      );
    } else if (usage === 'trustList') {
      this.snackBar
        .open(
          'Trust list key created! You can now configure your trust list.',
          'Go to Trust List',
          { duration: 5000 }
        )
        .onAction()
        .subscribe(() => {
          this.router.navigate(['/trust-list']);
        });
    } else if (usage === 'accessToken') {
      this.snackBar.open(
        'Access token key created! Choose it as the signing key of an authorization server in the issuance configuration.',
        'Close',
        { duration: 5000 }
      );
    } else if (usage === 'federation') {
      this.snackBar.open(
        'Federation key created! Your trust anchor needs its public key for the subordinate statement.',
        'View Key',
        { duration: 5000 }
      );
    }
  }

  /**
   * Generate a default description based on selections.
   */
  getDefaultDescription(): string {
    const usage = this.selectedUsage;

    if (usage === 'trustList') return 'Trust List Signing Key';
    if (usage === 'statusList') return 'Status List Signing Key';
    if (usage === 'attestation') return 'Credential Signing Key';
    if (usage === 'access') return 'Access Certificate';
    if (usage === 'federation') return 'OpenID Federation Entity Key';
    if (usage === 'accessToken') return 'Access Token Signing Key';
    return 'Key';
  }

  /**
   * Get summary text for review.
   */
  getSummary(): { label: string; value: string }[] {
    const summary = [];
    const usage = this.usageOptions.find((u) => u.value === this.selectedUsage);

    summary.push({ label: 'Usage', value: usage?.label || '' });

    if (this.showKeyChainTypeStep) {
      const keyChainType = this.keyChainTypeOptions.find(
        (c) => c.value === this.selectedKeyChainType
      );
      summary.push({ label: 'Key Chain Type', value: keyChainType?.label || '' });
    }

    if (this.selectedUsage === 'access') {
      summary.push({ label: 'Certificate', value: this.getCertificateSourceLabel() });
    }

    if (this.configForm.value.description) {
      summary.push({ label: 'Description', value: this.configForm.value.description });
    }

    const selectedKmsProvider = this.configForm.value.kmsProvider;
    if (selectedKmsProvider) {
      const providerInfo = this.availableKmsProviders.find((p) => p.name === selectedKmsProvider);
      summary.push({
        label: 'KMS Provider',
        value: providerInfo ? `${providerInfo.name} (${providerInfo.type})` : selectedKmsProvider,
      });
    }

    const algorithm = this.algorithmSummary();
    if (algorithm) summary.push({ label: 'Algorithm', value: algorithm });

    if (this.isInternalChain) {
      summary.push({
        label: 'Type',
        value: this.isExternalCaChain
          ? 'External CA Chain (Your CA + Signing Key)'
          : 'Internal Chain (Root CA + Signing Key)',
      });
      if (this.rotationEnabled) {
        summary.push({
          label: 'Rotation Interval',
          value: `${this.configForm.value.rotationIntervalDays} days`,
        });
      } else {
        summary.push({ label: 'Rotation', value: 'Off' });
      }
      summary.push({
        label: 'Certificate Validity',
        value: `${this.configForm.value.certValidityDays} days`,
      });
    } else {
      summary.push({
        label: 'Type',
        value: this.getKeyTypeLabel(),
      });
    }

    return summary;
  }

  /** The summary's algorithm: the chosen one, or the provider default for a registrar enrollment. */
  private algorithmSummary(): string | undefined {
    if (this.showAlgorithm) {
      const alg = this.configForm.value.alg as SigningAlgorithm;
      return SIGNING_ALGORITHM_LABELS[alg] ?? alg;
    }
    if (this.selectedUsage === 'access' && this.selectedAccessSource === 'registrar') {
      const alg = this.defaultAlgorithmOf(this.configForm.value.kmsProvider);
      return `${SIGNING_ALGORITHM_LABELS[alg]} (provider default)`;
    }
    return undefined;
  }

  private getCertificateSourceLabel(): string {
    if (this.selectedAccessSource === 'registrar') return 'Registrar Enrollment';
    if (this.selectedAccessSource === 'external') return 'External Certificate';
    return 'Self-Signed';
  }

  private getKeyTypeLabel(): string {
    if (this.selectedUsage === 'federation' || this.selectedUsage === 'accessToken') {
      return 'Standalone key (published as JWK)';
    }
    if (this.requestsCertificate) return 'Standalone (Certificate requested with a CSR)';
    return this.isExternalCertificate
      ? 'Standalone (External Certificate)'
      : 'Standalone (Self-signed)';
  }

  private parseExternalPrivateKey(): Pick<KeyChainImportDto, 'key' | 'keyPem'> {
    const value = this.configForm.value.externalPrivateKey.trim();
    if (value.includes('-----BEGIN PRIVATE KEY-----')) {
      return { keyPem: value };
    }

    try {
      const key = JSON.parse(value);
      if (!key || typeof key !== 'object' || !key.kty || !key.x || !key.y || !key.crv || !key.d) {
        throw new Error('Invalid private JWK');
      }
      return { key: key as NonNullable<KeyChainImportDto['key']> };
    } catch {
      throw new Error('The external private key must be a valid EC private JWK or PKCS#8 PEM key.');
    }
  }

  private parseCertificateChain(value: string): string[] {
    const certificates = value
      .trim()
      .split(/(?=-----BEGIN CERTIFICATE-----)/g)
      .map((certificate) => certificate.trim())
      .filter(Boolean);
    if (certificates.length === 0) {
      throw new Error('At least one certificate is required.');
    }
    return certificates;
  }

  async onPrivateKeyFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.configForm.patchValue({ externalPrivateKey: await file.text() });
  }

  async onCertificateFilesSelected(event: Event): Promise<void> {
    const files = (event.target as HTMLInputElement).files;
    if (!files?.length) return;
    this.configForm.patchValue({ externalCertificate: await readCertificateFiles(files) });
  }
}
