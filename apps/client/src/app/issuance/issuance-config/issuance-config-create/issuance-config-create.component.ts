import {
  Component,
  type OnInit,
  ChangeDetectionStrategy,
  ElementRef,
  Injector,
  ViewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  FormArray,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
  FormBuilder,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  IssuanceConfig,
  TrustList,
  trustListControllerGetAllTrustLists,
  UpdateIssuanceDto,
  WalletProviderTrustListRefDto,
} from '@eudiplo/sdk-core';
import {
  defaultAccessTokenLifetimeSeconds,
  IssuanceConfigService,
  statusCheckModeLabel,
  statusCheckModeOverride,
  type WalletAttestationStatusCheckMode,
} from '../issuance-config.service';
import { issuanceConfigSchema } from '../../../utils/schemas';
import { JsonViewDialogComponent } from '../../credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { MatSlideToggle, MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ImageFieldComponent } from '../../../utils/image-field/image-field.component';
import { MatCardModule } from '@angular/material/card';
import { PresentationManagementService } from '../../../presentation/presentation-config/presentation-management.service';
import { RegistrarService } from '../../../registrar/registrar.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { asSentence, getApiErrorMessage, getHttpErrorMessage } from '../../../utils/error-message';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { certificateBase64, certificateValidator } from '../../../utils/certificate-validator';
import { KeyChainService } from '../../../key-management/key-chain.service';
import { FrontendConfigService } from '../../../services/frontend-config.service';
import { JwtService } from '../../../services/jwt.service';
import { ApiService } from '../../../core';
import { entityIdUrl } from '../../../utils/public-url';
import { focusAfterRenderIfLost } from '../../../common/focus-if-lost.util';
import { FederationTrustAnchorSelectComponent } from '../../../federation-trust-anchor/federation-trust-anchor-select/federation-trust-anchor-select.component';
import {
  entityConfigurationUri,
  type FederationTrustAnchor,
  FederationTrustAnchorService,
} from '../../../federation-trust-anchor/federation-trust-anchor.service';
import { issuanceConfigTrustAnchorIds } from '../../../federation-trust-anchor/federation-trust-anchor-reference';

/** A managed list of this tenant, or an external list given by URL and signer certificate. */
type WalletProviderTrustListMode = 'managed' | 'external';

/** A stored wallet provider trust list entry; older entries may hold the JWK as a JSON string. */
type WalletProviderTrustListEntry = Omit<WalletProviderTrustListRefDto, 'verifierKey' | 'url'> & {
  url?: string;
  verifierKey?: Record<string, unknown> | string;
};

@Component({
  selector: 'app-issuance-config-create',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTabsModule,
    MatCheckboxModule,
    MatChipsModule,
    MatExpansionModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    NgTemplateOutlet,
    RouterModule,
    MatSlideToggleModule,
    MatSlideToggle,
    ImageFieldComponent,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    FederationTrustAnchorSelectComponent,
  ],
  templateUrl: './issuance-config-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './issuance-config-create.component.scss',
})
export class IssuanceConfigCreateComponent implements OnInit {
  private trustListVerifierValidator(control: AbstractControl): ValidationErrors | null {
    const value = control.value as {
      mode?: WalletProviderTrustListMode;
      trustListId?: string;
      url?: string;
      verifierCertificate?: string;
      legacyVerifierKey?: unknown;
      legacyVerifierKeyPem?: unknown;
    };

    if (value?.mode === 'managed') {
      return value.trustListId?.trim() ? null : { missingTrustList: true };
    }
    if (!value?.url?.trim()) return { missingUrl: true };
    if (value.verifierCertificate?.trim()) return null;
    // Entries saved before only certificates were accepted keep their public key until replaced.
    return value.legacyVerifierKey || value.legacyVerifierKeyPem ? null : { missingVerifier: true };
  }

  /**
   * Form group for one wallet provider trust list. The list signer is given as
   * an X.509 certificate (PEM or Base64 DER); a public key stored on an
   * existing entry is carried along unchanged until a certificate replaces it.
   */
  private createWalletProviderTrustListGroup(
    entry?: WalletProviderTrustListEntry,
    mode: WalletProviderTrustListMode = entry?.trustListId?.trim() ? 'managed' : 'external'
  ): FormGroup {
    let legacyVerifierKey: Record<string, unknown> | null = null;
    if (entry?.verifierKey && typeof entry.verifierKey === 'object') {
      legacyVerifierKey = entry.verifierKey;
    } else if (typeof entry?.verifierKey === 'string' && entry.verifierKey.trim()) {
      try {
        legacyVerifierKey = JSON.parse(entry.verifierKey) as Record<string, unknown>;
      } catch {
        legacyVerifierKey = null;
      }
    }
    return this.fb.group(
      {
        mode: [mode],
        trustListId: [entry?.trustListId ?? ''],
        url: [entry?.url ?? ''],
        verifierCertificate: [
          typeof entry?.verifierX509Der === 'string' ? entry.verifierX509Der : '',
          [certificateValidator],
        ],
        legacyVerifierKey: [legacyVerifierKey],
        legacyVerifierKeyPem: [
          typeof entry?.verifierKeyPem === 'string' && entry.verifierKeyPem.trim()
            ? entry.verifierKeyPem
            : null,
        ],
        storedVerifierX509Der: [
          typeof entry?.verifierX509Der === 'string' ? entry.verifierX509Der : null,
        ],
      },
      {
        validators: [this.trustListVerifierValidator.bind(this)],
      }
    );
  }

  /**
   * Names the public key a stored trust list entry pins ("JWK", "PEM" or
   * both), or null when there is none or a different certificate replaces it on save.
   */
  pinnedPublicKey(trustList: AbstractControl): string | null {
    const { verifierCertificate, storedVerifierX509Der, legacyVerifierKey, legacyVerifierKeyPem } =
      trustList.value;
    const kinds = [legacyVerifierKey && 'JWK', legacyVerifierKeyPem && 'PEM'].filter(Boolean);
    if (!kinds.length) return null;
    return IssuanceConfigCreateComponent.newCertificate(verifierCertificate, storedVerifierX509Der)
      ? null
      : kinds.join(' and ');
  }

  /**
   * The entered certificate as Base64 DER when it differs from the stored one,
   * so it replaces any stored public key on save; otherwise undefined.
   */
  private static newCertificate(entered: unknown, stored: unknown): string | undefined {
    const certificate =
      typeof entered === 'string' && entered.trim() ? certificateBase64(entered) : undefined;
    const previous = typeof stored === 'string' ? certificateBase64(stored) : undefined;
    return certificate !== previous ? certificate : undefined;
  }

  private createWalletProviderTrustListArray(entries?: any[]): FormArray {
    const trustLists = this.fb.array<FormGroup>([]);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        trustLists.push(
          this.createWalletProviderTrustListGroup(
            typeof entry === 'string' ? { url: entry } : entry
          )
        );
      }
    }
    return trustLists;
  }

  private createAuthorizationServerWalletAttestationControls(value?: any) {
    const trustLists = this.createWalletProviderTrustListArray(value?.walletProviderTrustLists);
    const inherit = new FormControl(
      value?.inheritWalletProviderTrustLists ?? value?.walletProviderTrustLists == null
    );
    const updateTrustListValidation = () => {
      if (inherit.value) {
        trustLists.disable({ emitEvent: false });
      } else {
        trustLists.enable({ emitEvent: false });
      }
    };
    updateTrustListValidation();
    inherit.valueChanges.subscribe(updateTrustListValidation);
    return {
      walletAttestationRequired: new FormControl(value?.walletAttestationRequired ?? 'inherit'),
      walletAttestationStatusCheckMode: new FormControl<
        WalletAttestationStatusCheckMode | 'inherit'
      >(value?.walletAttestationStatusCheckMode ?? 'inherit'),
      inheritWalletProviderTrustLists: inherit,
      walletProviderTrustLists: trustLists,
    };
  }

  private buildWalletProviderTrustLists(value: any[] | undefined): any[] {
    return value?.length
      ? value
          .map((entry: any) => {
            if (entry?.mode !== 'external' && entry?.trustListId?.trim()) {
              return { trustListId: entry.trustListId.trim() };
            }
            const url = entry?.url?.trim() || undefined;
            const certificate =
              typeof entry?.verifierCertificate === 'string' && entry.verifierCertificate.trim()
                ? certificateBase64(entry.verifierCertificate)
                : undefined;
            // A new certificate replaces any stored public key; otherwise the entry is kept as loaded.
            if (
              IssuanceConfigCreateComponent.newCertificate(
                entry?.verifierCertificate,
                entry?.storedVerifierX509Der
              )
            ) {
              return { url, verifierX509Der: certificate };
            }
            return {
              url,
              verifierKey: entry?.legacyVerifierKey ?? undefined,
              verifierKeyPem: entry?.legacyVerifierKeyPem?.trim() || undefined,
              verifierX509Der: certificate,
            };
          })
          .filter((entry: any) => !!entry.trustListId || !!entry.url)
      : [];
  }

  guidedMode = false;
  activeStep = 0;
  furthestStep = 0;
  stepError = '';
  loadingConfig = true;
  loadError = '';
  trustLists: TrustList[] = [];
  trustListsLoading = false;
  trustListsLoaded = false;
  trustListsError = '';
  readonly stepNames = ['Identity', 'Wallet access', 'Trust', 'Review'];
  expandedSections = new Set<string>();
  expandedServers = new Set<AbstractControl>();

  toggleGuidedMode(): void {
    this.guidedMode = !this.guidedMode;
    this.activeStep = 0;
    this.furthestStep = 0;
    this.stepError = '';
  }

  private validateStep(step: number): boolean {
    let error = '';
    const controls =
      step === 0
        ? ['display']
        : step === 1
          ? [
              'authorizationServers',
              'batchSize',
              'dPopRequired',
              'credentialResponseEncryption',
              'credentialRequestEncryption',
              'notificationEndpointEnabled',
            ]
          : [
              'txCodeMaxAttempts',
              'walletAttestationRequired',
              'walletAttestationStatusCheckMode',
              'walletProviderTrustLists',
              'federation',
              'registrationCertificate',
            ];
    if (step === 0 && !this.displays.length) error = 'Add an issuer name and language.';
    if (step === 1) {
      const servers = this.authorizationServers.controls;
      if (
        !servers.some(
          (server) =>
            server.get('type')?.value === 'external' || server.get('enabled')?.value !== false
        )
      )
        error = 'Add at least one enabled authorization server.';
      const ids = servers.map((server) => `${server.get('id')?.value || ''}`.trim());
      if (ids.some((id) => !id)) error = 'Enter an ID for every authorization server.';
      if (ids.some((id) => ['built-in', 'chained-as'].includes(id)))
        error = 'The IDs built-in and chained-as are reserved. Choose another server ID.';
      if (new Set(ids).size !== ids.length) error = 'Authorization server IDs must be unique.';
      for (const server of servers) {
        const value = server.value;
        if (value.enabled === false) continue;
        if (value.type === 'oid4vp' && !value.oid4vp?.presentationConfigId)
          error = 'Choose a presentation configuration for each hosted presentation flow.';
        if (
          value.type === 'chained' &&
          (!value.chained?.issuer?.trim() || !value.chained?.clientId?.trim())
        )
          error = 'Enter an upstream issuer and client ID for each chained authorization server.';
      }
    }
    if (step === 2) {
      if (this.federationEnabled && !this.trustAnchors.length)
        error = 'Add a trust anchor or turn off OpenID Federation.';
      else if (this.federationEnabled && this.newUnregisteredTrustAnchors.length)
        error = `Register ${this.newUnregisteredTrustAnchors.join(', ')} as a federation trust anchor first, or choose a registered one.`;
      if (
        this.registrationCertificateEnabled &&
        this.registrationCertificateMode === 'import' &&
        !this.registrationCertificate.get('jwt')?.value?.trim()
      )
        error = 'Paste a registration certificate JWT or choose automatic generation.';
    }
    const invalid = controls.filter((name) => this.form.get(name)?.invalid);
    if (!error && !invalid.length) {
      this.stepError = '';
      return true;
    }
    controls.forEach((name) => this.form.get(name)?.markAllAsTouched());
    if (step === 1) {
      this.expandedSections.add('behavior');
      this.authorizationServers.controls.forEach((server) => this.expandedServers.add(server));
    }
    if (step === 2)
      ['wallet', 'federation', 'registration'].forEach((key) => this.expandedSections.add(key));
    this.activeStep = step;
    this.furthestStep = Math.max(this.furthestStep, step);
    this.stepError = error || `Check the highlighted fields in ${this.stepNames[step]}.`;
    return false;
  }

  nextStep(): void {
    if (this.loading || this.loadingConfig || !this.validateStep(this.activeStep)) return;
    if (this.activeStep === 2)
      for (let step = 0; step < 2; step++) if (!this.validateStep(step)) return;
    this.activeStep = Math.min(3, this.activeStep + 1);
    this.furthestStep = Math.max(this.furthestStep, this.activeStep);
  }

  previousStep(): void {
    this.activeStep = Math.max(0, this.activeStep - 1);
    this.stepError = '';
  }

  submitSettings(): void {
    if (this.guidedMode && this.activeStep < 3) this.nextStep();
    else this.onSubmit();
  }

  onInputEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.isComposing || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return;
    key.preventDefault();
    key.stopPropagation();
    this.submitSettings();
  }

  /** The issuer default an authorization server inherits, for the "Use issuer default" option. */
  get issuerStatusCheckModeLabel(): string {
    return statusCheckModeLabel(this.form.get('walletAttestationStatusCheckMode')?.value);
  }

  get behaviorSummary(): string {
    const value = this.form.value;
    return `Batch size: ${value.batchSize} · DPoP: ${value.dPopRequired ? 'Required' : 'Optional'} · Request encryption: ${value.credentialRequestEncryption ? 'Required' : 'Off'} · Response encryption: ${value.credentialResponseEncryption ? 'Advertised' : 'Off'} · Notifications: ${value.notificationEndpointEnabled ? 'On' : 'Off'}`;
  }

  get trustSummary(): string {
    return `Wallet attestation default: ${this.form.get('walletAttestationRequired')?.value ? 'Required' : 'Optional'} · Wallet attestation status check: ${this.issuerStatusCheckModeLabel}${this.form.get('walletAttestationStatusCheckMode')?.value === 'disabled' ? ' (revoked attestations accepted)' : ''} · Wallet provider trust lists: ${this.walletProviderTrustLists.length} · Federation: ${this.federationEnabled ? 'On' : 'Off'} · Registration certificate: ${this.registrationCertificateEnabled ? this.registrationCertificateMode : 'Off'} · PIN attempt limit: ${this.form.get('txCodeMaxAttempts')?.value ?? 5}`;
  }

  public form: FormGroup;
  public loading = false;
  public availablePresentationConfigIds: string[] = [];
  private readonly federationModes = ['federation-only', 'hybrid'] as const;

  /**
   * Entity configuration settings of the loaded federation block that this
   * form does not edit (entityTypes, authorityHints, trust marks, ...). They
   * are sent back unchanged, so saving the form keeps them.
   */
  private federationEntitySettings: Record<string, unknown> = {};

  /** Whether the loaded configuration published an entity configuration (entity ID and trust anchors). */
  federationWasPublished = false;

  /** Entity ID EUDIPLO serves this tenant's entity configuration under; null until known. */
  expectedEntityId: string | null = null;

  /** True when the backend did not report PUBLIC_URL and expectedEntityId uses the instance URL. */
  expectedEntityIdUsesInstanceUrl = false;

  /** IDs of the tenant's key chains with usage type federation; null while unknown. */
  private federationKeyChainIds: string[] | null = null;

  /** The tenant's key chains with usage type accessToken; null while unknown. */
  accessTokenKeyChains: { id: string; description?: string }[] | null = null;

  /** True when the last request for the key chains failed. */
  accessTokenKeyChainsLoadFailed = false;

  /** True while loadFederationSetup runs. */
  checkingFederationKey = false;

  /** Result of the last "Check again" that still found no federation key. */
  federationKeyCheckMessage = '';

  @ViewChild('entityIdInput', { read: ElementRef })
  private readonly entityIdInput?: ElementRef<HTMLInputElement>;
  /** Trust anchors of the stored configuration, which the backend keeps even when unregistered. */
  private storedTrustAnchorIds = new Set<string>();
  private registrarRegistrationCertificateDefaults: Record<string, unknown> | null = null;

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  private normalizeFederationMode(value: unknown): 'federation-only' | 'hybrid' {
    return this.federationModes.includes(value as (typeof this.federationModes)[number])
      ? (value as 'federation-only' | 'hybrid')
      : 'hybrid';
  }

  constructor(
    private readonly issuanceConfigService: IssuanceConfigService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog,
    private readonly fb: FormBuilder,
    private readonly presentationManagementService: PresentationManagementService,
    private readonly registrarService: RegistrarService,
    private readonly keyChainService: KeyChainService,
    private readonly frontendConfigService: FrontendConfigService,
    private readonly jwtService: JwtService,
    private readonly apiService: ApiService,
    private readonly injector: Injector,
    private readonly federationTrustAnchors: FederationTrustAnchorService
  ) {
    this.form = new FormGroup({
      display: this.fb.array([]),
      authorizationServers: this.fb.array([]),
      batchSize: new FormControl(1, [Validators.required, Validators.min(1)]),
      dPopRequired: new FormControl(false),
      txCodeMaxAttempts: new FormControl<number | null>(null, [Validators.min(1)]),
      credentialResponseEncryption: new FormControl(false),
      credentialRequestEncryption: new FormControl(false),
      notificationEndpointEnabled: new FormControl(true),
      walletAttestationRequired: new FormControl(false),
      walletAttestationStatusCheckMode: new FormControl<WalletAttestationStatusCheckMode | null>(
        null
      ),
      walletProviderTrustLists: this.fb.array([]),
      federation: this.fb.group({
        enabled: [false],
        mode: ['hybrid'],
        // Copy of the editor pattern in the backend issuance schema; the
        // backend (federationEntityIdProblem in @eudiplo/config-format)
        // checks the rest, and whether http is allowed.
        entityId: ['', Validators.pattern(/^https?:\/\/[^\s?#]+$/)],
        cacheTtlSeconds: [300],
        trustAnchors: this.fb.array([]),
      }),
      registrationCertificate: this.fb.group({
        enabled: [false],
        mode: ['generate'],
        jwt: [''],
        privacyPolicy: [''],
        supportUri: [''],
      }),
    } as any);
    // Hidden federation fields must not block saving.
    const updateFederationValidation = () => {
      for (const control of [this.trustAnchors, this.federation.get('entityId')!]) {
        if (this.federationEnabled) control.enable({ emitEvent: false });
        else control.disable({ emitEvent: false });
      }
    };
    this.federation.get('enabled')!.valueChanges.subscribe(updateFederationValidation);
    updateFederationValidation();
  }

  ngOnInit(): void {
    // Defer network/config hydration so tab navigation is interactive immediately.
    setTimeout(() => {
      this.loadPresentationConfigs();
      void this.loadConfigForEdit();
      void this.loadRegistrarDefaults();
      void this.loadTrustLists();
      void this.loadFederationSetup();
    }, 0);
  }

  /**
   * Loads what the federation card checks the entity ID against: the URL the
   * backend serves the entity configuration under, built from PUBLIC_URL like
   * the backend does, and whether a federation key exists to sign it.
   */
  async loadFederationSetup(): Promise<unknown> {
    const tenantId = this.jwtService.getTenantId();
    this.checkingFederationKey = true;
    let frontendConfig: Awaited<ReturnType<FrontendConfigService['getConfig']>>;
    let keyChains: Awaited<ReturnType<KeyChainService['getAll']>> | null;
    let keyChainsError: unknown = null;
    try {
      [frontendConfig, keyChains] = await Promise.all([
        this.frontendConfigService.getConfig(),
        this.keyChainService.getAll().catch((error: unknown) => {
          keyChainsError = error ?? new Error('Key chains unavailable');
          return null;
        }),
      ]);
    } finally {
      this.checkingFederationKey = false;
    }
    // A config without publicUrl means an older backend; no config means the
    // request failed, and then no URL is suggested at all.
    const publicUrl = frontendConfig
      ? (frontendConfig.publicUrl ?? this.apiService.getBaseUrl())
      : null;
    this.expectedEntityIdUsesInstanceUrl = !!frontendConfig && !frontendConfig.publicUrl;
    this.expectedEntityId = tenantId && publicUrl ? entityIdUrl(publicUrl, tenantId) : null;
    // A failed request keeps what is known; without any list, say nothing
    // rather than claim the key is missing.
    this.accessTokenKeyChainsLoadFailed = !keyChains;
    if (keyChains) {
      this.federationKeyChainIds = keyChains
        .filter((keyChain) => keyChain.usageType === 'federation')
        .map((keyChain) => keyChain.id);
      this.accessTokenKeyChains = keyChains
        .filter((keyChain) => keyChain.usageType === 'accessToken')
        .map(({ id, description }) => ({ id, description }));
    }
    return keyChainsError;
  }

  /** Reloads the key chains after the user created a federation key in another tab. */
  /** Reloads the key chains after the user created an access token key in another tab. */
  async checkAccessTokenKeysAgain(): Promise<void> {
    const error = await this.loadFederationSetup();
    if (error) {
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Could not load the access token keys')
      );
    }
  }

  async checkFederationKeyAgain(): Promise<void> {
    this.federationKeyCheckMessage = '';
    const error = await this.loadFederationSetup();
    if (error) {
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Could not check the federation keys')
      );
    } else if (this.federationKeyMissing) {
      this.federationKeyCheckMessage = 'Still no matching federation key.';
    } else {
      this.snackBar.open('Federation key found', 'Close', { duration: 3000 });
      // The warning with the focused button is gone.
      focusAfterRenderIfLost(this.injector, () => this.entityIdInput?.nativeElement);
    }
  }

  /** Key chain ID that federation.entityKeyChainId pins, or null without a pin. */
  get pinnedFederationKeyChainId(): string | null {
    const pinned = this.federationEntitySettings['entityKeyChainId'];
    return typeof pinned === 'string' && pinned ? pinned : null;
  }

  /**
   * Whether a federation key exists that can sign the entity configuration: the
   * one federation.entityKeyChainId pins, or any one without a pin. Null while unknown.
   */
  get hasFederationKey(): boolean | null {
    if (!this.federationKeyChainIds) return null;
    const pinned = this.pinnedFederationKeyChainId;
    return pinned
      ? this.federationKeyChainIds.includes(pinned)
      : this.federationKeyChainIds.length > 0;
  }

  /** The entity ID entered in the federation card, trimmed. */
  get entityId(): string {
    return `${this.federation.get('entityId')?.value ?? ''}`.trim();
  }

  /** True when an entity ID is set that differs from the URL the entity configuration is served under. */
  get entityIdDiffers(): boolean {
    return !!this.entityId && !!this.expectedEntityId && this.entityId !== this.expectedEntityId;
  }

  /** True when an entity ID is set but no federation key exists to sign the entity configuration. */
  get federationKeyMissing(): boolean {
    return !!this.entityId && this.hasFederationKey === false;
  }

  useExpectedEntityId(): void {
    if (!this.expectedEntityId) return;
    const control = this.federation.get('entityId')!;
    control.setValue(this.expectedEntityId);
    control.markAsDirty();
  }

  private async loadRegistrarDefaults(): Promise<void> {
    try {
      const config = await this.registrarService.getConfig();
      const defaults = config?.registrationCertificateDefaults;
      if (!defaults || typeof defaults !== 'object') {
        this.registrarRegistrationCertificateDefaults = null;
        return;
      }

      this.registrarRegistrationCertificateDefaults = defaults as Record<string, unknown>;
      this.applyRegistrationCertificateDefaultsIfMissing(defaults as Record<string, unknown>);
    } catch {
      // Keep form editable even if registrar settings are unavailable.
    }
  }

  async applyRegistrarDefaultsFromRegistrar(): Promise<void> {
    try {
      const config = await this.registrarService.getConfig();
      const defaults = config?.registrationCertificateDefaults;

      if (!defaults || typeof defaults !== 'object') {
        this.snackBar.open(
          'No registration certificate defaults configured in registrar',
          'Close',
          {
            duration: 3000,
          }
        );
        return;
      }

      this.registrarRegistrationCertificateDefaults = defaults as Record<string, unknown>;
      this.applyRegistrationCertificateDefaults(defaults as Record<string, unknown>, true);
      this.snackBar.open('Loaded privacy policy and support URI from registrar defaults', 'Close', {
        duration: 2500,
      });
    } catch (error) {
      openErrorSnackBar(
        this.snackBar,
        getHttpErrorMessage(error, 'Failed to load registrar defaults')
      );
    }
  }

  private applyRegistrationCertificateDefaultsIfMissing(defaults: Record<string, unknown>): void {
    this.applyRegistrationCertificateDefaults(defaults, false);
  }

  private applyRegistrationCertificateDefaults(
    defaults: Record<string, unknown>,
    overwriteExisting: boolean
  ): void {
    const privacy =
      typeof defaults['privacy_policy'] === 'string' ? defaults['privacy_policy'].trim() : '';
    const support =
      typeof defaults['support_uri'] === 'string' ? defaults['support_uri'].trim() : '';

    const registrationCertificate = this.registrationCertificate;
    const privacyCtrl = registrationCertificate.get('privacyPolicy');
    const supportCtrl = registrationCertificate.get('supportUri');

    const currentPrivacy = `${privacyCtrl?.value ?? ''}`.trim();
    const currentSupport = `${supportCtrl?.value ?? ''}`.trim();

    if ((overwriteExisting || !currentPrivacy) && privacy) {
      privacyCtrl?.setValue(privacy);
    }
    if ((overwriteExisting || !currentSupport) && support) {
      supportCtrl?.setValue(support);
    }
  }

  async loadConfigForEdit(): Promise<void> {
    this.loadingConfig = true;
    this.loadError = '';
    try {
      const config = await this.issuanceConfigService.getConfig();
      if (!config) throw new Error('Issuer settings unavailable');
      this.storedTrustAnchorIds = new Set(issuanceConfigTrustAnchorIds(config));
      // The Trust step checks added trust anchors against this list; the pickers share it.
      this.federationTrustAnchors.registeredAnchors().catch(() => undefined);
      await this.applyConfiguration(config);
      // No identity yet: offer the onboarding flow while retaining the server defaults.
      this.guidedMode =
        !config.display?.length || this.route.snapshot.queryParamMap?.get('setup') === 'true';
      if (!this.displays.length) this.addDisplay();
    } catch (error) {
      this.loadError = `${asSentence(getApiErrorMessage(error, 'Could not load issuer settings'))} Retry before making changes.`;
    } finally {
      this.loadingConfig = false;
    }
  }

  private async applyConfiguration(config: IssuanceConfig): Promise<void> {
    // Load display configurations
    const displayArray = this.form.get('display') as FormArray;
    displayArray.clear();
    if (config.display && Array.isArray(config.display)) {
      for (const [index, entry] of config.display.entries()) {
        const displayEntry = this.asRecord(entry);
        const logo = this.asRecord(displayEntry['logo']);
        displayArray.push(
          this.fb.group({
            name: [
              typeof displayEntry['name'] === 'string' ? displayEntry['name'] : '',
              Validators.required,
            ],
            locale: [
              typeof displayEntry['locale'] === 'string' ? displayEntry['locale'] : '',
              Validators.required,
            ],
            logo: this.fb.group({
              uri: [typeof logo['uri'] === 'string' ? logo['uri'] : ''],
            }),
          })
        );

        if (index > 0 && index % 5 === 0) {
          await this.yieldToUi();
        }
      }
    }

    await this.yieldToUi();

    const authorizationServersArray = this.form.get('authorizationServers') as FormArray;
    authorizationServersArray.clear();
    if (
      (config as any).authorizationServers &&
      Array.isArray((config as any).authorizationServers)
    ) {
      const allServers = (config as any).authorizationServers;
      for (const [index, server] of allServers.entries()) {
        if (server?.type === 'external') {
          authorizationServersArray.push(
            this.createAuthorizationServerGroup({
              type: 'external',
              id: server.id ?? `external-${index + 1}`,
              issuer: server.issuer ?? '',
              label: server.label ?? server.issuer ?? '',
            })
          );
        } else if (server?.type === 'oid4vp' || server?.type === 'chained') {
          authorizationServersArray.push(
            this.createAuthorizationServerGroup({
              id: server.id ?? `${server.type || 'auth'}-${index + 1}`,
              label:
                server.label ??
                `${server.type === 'chained' ? 'Chained' : 'Hosted'} AS ${index + 1}`,
              type: server.type ?? 'oid4vp',
              enabled: server.enabled ?? true,
              requireDPoP: server.requireDPoP ?? false,
              walletAttestationRequired: server.walletAttestationRequired ?? 'inherit',
              walletAttestationStatusCheckMode:
                server.walletAttestationStatusCheckMode ?? 'inherit',
              walletProviderTrustLists: server.walletProviderTrustLists,
              oid4vp: {
                presentationConfigId:
                  server.presentationConfigId ?? server.oid4vp?.presentationConfigId ?? '',
                immediateWalletRedirect:
                  server.immediateWalletRedirect ?? server.oid4vp?.immediateWalletRedirect ?? true,
              },
              chained: {
                issuer: server.upstream?.issuer ?? '',
                clientId: server.upstream?.clientId ?? '',
                clientSecret: server.upstream?.clientSecret ?? '',
                scopes: server.upstream?.scopes ?? ['openid', 'profile', 'email'],
              },
              token: {
                lifetimeSeconds:
                  server.token?.lifetimeSeconds ?? defaultAccessTokenLifetimeSeconds(server.type),
                signingKeyId: server.token?.signingKeyId ?? '',
                refreshTokenEnabled: server.token?.refreshTokenEnabled ?? true,
                refreshTokenExpiresInSeconds: server.token?.refreshTokenExpiresInSeconds ?? 2592000,
              },
            })
          );
        } else if (server?.type === 'built-in') {
          authorizationServersArray.push(
            this.createAuthorizationServerGroup({
              type: 'built-in',
              id: server.id ?? 'issuer-built-in',
              label: server.label ?? 'Built-in Authorization Server',
              enabled: server.enabled ?? true,
              requireDPoP: server.requireDPoP ?? false,
              walletAttestationRequired: server.walletAttestationRequired ?? 'inherit',
              walletAttestationStatusCheckMode:
                server.walletAttestationStatusCheckMode ?? 'inherit',
              walletProviderTrustLists: server.walletProviderTrustLists,
              token: {
                lifetimeSeconds:
                  server.token?.lifetimeSeconds ?? defaultAccessTokenLifetimeSeconds('built-in'),
                signingKeyId: server.token?.signingKeyId ?? '',
                refreshTokenEnabled: server.token?.refreshTokenEnabled ?? true,
                refreshTokenExpiresInSeconds: server.token?.refreshTokenExpiresInSeconds ?? 2592000,
              },
            })
          );
        }

        if (index > 0 && index % 5 === 0) {
          await this.yieldToUi();
        }
      }
    }

    await this.yieldToUi();

    // Load wallet provider trust lists
    this.form.setControl(
      'walletProviderTrustLists',
      this.createWalletProviderTrustListArray(config.walletProviderTrustLists as any[])
    );

    await this.yieldToUi();

    // Patch other form values
    const registrationCertificate = (config as any).registrationCertificate;
    this.form.patchValue({
      batchSize: config.batchSize ?? 1,
      dPopRequired: config.dPopRequired ?? false,
      credentialResponseEncryption:
        (config as { credentialResponseEncryption?: boolean }).credentialResponseEncryption ??
        false,
      credentialRequestEncryption:
        (config as { credentialRequestEncryption?: boolean }).credentialRequestEncryption ?? false,
      notificationEndpointEnabled:
        (config as { notificationEndpointEnabled?: boolean }).notificationEndpointEnabled ?? true,
      walletAttestationRequired: config.walletAttestationRequired ?? false,
      walletAttestationStatusCheckMode: config.walletAttestationStatusCheckMode ?? null,
      txCodeMaxAttempts: config.txCodeMaxAttempts ?? null,
      registrationCertificate: {
        enabled: registrationCertificate?.enabled ?? false,
        mode: registrationCertificate?.mode ?? 'generate',
        jwt: registrationCertificate?.jwt ?? '',
        privacyPolicy: registrationCertificate?.privacyPolicy ?? '',
        supportUri: registrationCertificate?.supportUri ?? '',
      },
    });

    this.trustAnchors.clear();
    this.federationEntitySettings = {};
    this.federationWasPublished = false;
    this.federation.patchValue({
      enabled: false,
      mode: 'hybrid',
      entityId: '',
      cacheTtlSeconds: 300,
    });
    // Load Federation config if present
    if (config && (config as any)['federation']) {
      const federation = (config as any)['federation'];
      // Keys the form edits; everything else is carried over unchanged.
      const edited = new Set([
        'role',
        'mode',
        'entityId',
        'enforceSigningPolicy',
        'cacheTtlSeconds',
        'trustAnchors',
      ]);
      this.federationWasPublished =
        !!federation.entityId &&
        Array.isArray(federation.trustAnchors) &&
        federation.trustAnchors.length > 0;
      this.federationEntitySettings = Object.fromEntries(
        Object.entries(federation).filter(([key]) => !edited.has(key))
      );
      this.trustAnchors.clear();
      if (federation.trustAnchors && Array.isArray(federation.trustAnchors)) {
        for (const [index, anchor] of federation.trustAnchors.entries()) {
          this.trustAnchors.push(
            this.fb.group({
              entityId: [anchor.entityId ?? '', Validators.required],
              entityConfigurationUri: [anchor.entityConfigurationUri ?? '', Validators.required],
            })
          );

          if (index > 0 && index % 5 === 0) {
            await this.yieldToUi();
          }
        }
      }
      this.form.patchValue({
        federation: {
          enabled: this.trustAnchors.length > 0,
          mode: this.normalizeFederationMode(federation.mode),
          entityId: federation.entityId ?? '',
          cacheTtlSeconds: federation.cacheTtlSeconds ?? 300,
        },
      });
    }

    await this.yieldToUi();

    if (this.registrarRegistrationCertificateDefaults) {
      this.applyRegistrationCertificateDefaultsIfMissing(
        this.registrarRegistrationCertificateDefaults
      );
    }

    if (this.federationEnabled) this.expandedSections.add('federation');
    if (this.registrationCertificateEnabled) this.expandedSections.add('registration');
    if (this.walletProviderTrustLists.length || this.form.get('walletAttestationRequired')?.value)
      this.expandedSections.add('wallet');
    this.activeStep = 0;
    this.furthestStep = 0;
    this.stepError = '';
  }

  private async yieldToUi(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private loadPresentationConfigs(): void {
    this.presentationManagementService.loadConfigurations().then(
      (configs) => {
        this.availablePresentationConfigIds = (configs || [])
          .map((config) => config.id)
          .filter((id): id is string => !!id)
          .sort((a, b) => a.localeCompare(b));
      },
      (error) => {
        console.error('Failed to load presentation configs:', error);
      }
    );
  }

  private buildUnifiedAuthorizationServers(formValue: any): any[] {
    const authorizationServers = formValue.authorizationServers?.length
      ? formValue.authorizationServers
          .filter((server: any) => {
            if (server?.type === 'external') {
              return (
                typeof server?.id === 'string' &&
                server.id.trim().length > 0 &&
                typeof server?.issuer === 'string' &&
                server.issuer.trim().length > 0
              );
            }
            return typeof server?.id === 'string' && server.id.trim().length > 0;
          })
          .map((server: any) => {
            if (server.type === 'external') {
              const issuer = server.issuer.trim();
              return {
                id: server.id.trim(),
                type: 'external',
                issuer,
                label: server.label?.trim() || issuer,
              };
            }

            if (server.type === 'built-in') {
              const walletProviderTrustLists = server.inheritWalletProviderTrustLists
                ? undefined
                : this.buildWalletProviderTrustLists(server.walletProviderTrustLists);
              return {
                id: server.id.trim(),
                type: 'built-in',
                label: server.label?.trim() || 'Built-in Authorization Server',
                enabled: server.enabled ?? true,
                requireDPoP: server.requireDPoP ?? false,
                walletAttestationRequired:
                  typeof server.walletAttestationRequired === 'boolean'
                    ? server.walletAttestationRequired
                    : undefined,
                walletAttestationStatusCheckMode: statusCheckModeOverride(
                  server.walletAttestationStatusCheckMode
                ),
                walletProviderTrustLists,
                token: {
                  lifetimeSeconds:
                    server.token?.lifetimeSeconds || defaultAccessTokenLifetimeSeconds('built-in'),
                  signingKeyId: server.token?.signingKeyId || undefined,
                  refreshTokenEnabled: server.token?.refreshTokenEnabled ?? true,
                  refreshTokenExpiresInSeconds: server.token?.refreshTokenEnabled
                    ? server.token?.refreshTokenExpiresInSeconds || 2592000
                    : undefined,
                },
              };
            }

            const walletProviderTrustLists = server.inheritWalletProviderTrustLists
              ? undefined
              : this.buildWalletProviderTrustLists(server.walletProviderTrustLists);
            const base = {
              id: server.id,
              label: server.label,
              type: server.type,
              enabled: server.enabled ?? true,
              requireDPoP: server.requireDPoP ?? false,
              walletAttestationRequired:
                typeof server.walletAttestationRequired === 'boolean'
                  ? server.walletAttestationRequired
                  : undefined,
              walletAttestationStatusCheckMode: statusCheckModeOverride(
                server.walletAttestationStatusCheckMode
              ),
              walletProviderTrustLists,
              token: {
                lifetimeSeconds:
                  server.token?.lifetimeSeconds || defaultAccessTokenLifetimeSeconds(server.type),
                signingKeyId: server.token?.signingKeyId || undefined,
                refreshTokenEnabled: server.token?.refreshTokenEnabled ?? true,
                refreshTokenExpiresInSeconds: server.token?.refreshTokenEnabled
                  ? server.token?.refreshTokenExpiresInSeconds || 2592000
                  : undefined,
              },
            } as Record<string, unknown>;

            if (server.type === 'chained') {
              return {
                ...base,
                upstream: {
                  issuer: server.chained?.issuer,
                  clientId: server.chained?.clientId,
                  // Shown as <redacted> when stored, which keeps it; empty means no secret.
                  clientSecret: server.chained?.clientSecret || undefined,
                  scopes: server.chained?.scopes,
                },
              };
            }

            return {
              ...base,
              presentationConfigId: server.oid4vp?.presentationConfigId,
              immediateWalletRedirect: server.oid4vp?.immediateWalletRedirect ?? true,
            };
          })
      : [];

    return authorizationServers;
  }

  private buildRegistrationCertificatePayload(registrationCertificateFormValue: any): any {
    if (!registrationCertificateFormValue?.enabled) {
      return null;
    }

    if (registrationCertificateFormValue.mode === 'import') {
      return {
        enabled: true,
        mode: 'import',
        jwt: registrationCertificateFormValue.jwt || undefined,
      };
    }

    return {
      enabled: true,
      mode: 'generate',
      privacyPolicy: registrationCertificateFormValue.privacyPolicy || undefined,
      supportUri: registrationCertificateFormValue.supportUri || undefined,
    };
  }

  private buildConfigurationPayload(): UpdateIssuanceDto {
    const formValue = this.form.value;

    const unifiedAuthorizationServers = this.buildUnifiedAuthorizationServers(formValue);
    const registrationCertificate = this.buildRegistrationCertificatePayload(
      formValue.registrationCertificate
    );

    return {
      batchSize: formValue.batchSize,
      // The API requires `uri` when a logo is set.
      display: (formValue.display ?? []).map(({ logo, ...display }: any) => ({
        ...display,
        ...(logo?.uri ? { logo } : {}),
      })),
      dPopRequired: formValue.dPopRequired,
      credentialResponseEncryption: formValue.credentialResponseEncryption ?? false,
      credentialRequestEncryption: formValue.credentialRequestEncryption ?? false,
      notificationEndpointEnabled: formValue.notificationEndpointEnabled ?? true,
      txCodeMaxAttempts: formValue.txCodeMaxAttempts ?? null,
      authorizationServers:
        unifiedAuthorizationServers.length > 0 ? unifiedAuthorizationServers : [],
      walletAttestationRequired: formValue.walletAttestationRequired,
      walletAttestationStatusCheckMode: formValue.walletAttestationStatusCheckMode ?? null,
      walletProviderTrustLists: this.buildWalletProviderTrustLists(
        formValue.walletProviderTrustLists
      ),
      federation: this.buildFederationConfig(formValue.federation),
      registrationCertificate,
    };
  }

  onSubmit(): void {
    if (this.loading || this.loadingConfig || this.loadError) return;
    for (let step = 0; step < 3; step++) if (!this.validateStep(step)) return;
    let issuanceDto: UpdateIssuanceDto;
    try {
      issuanceDto = this.buildConfigurationPayload();
    } catch {
      this.stepError = 'Check the highlighted fields in Trust.';
      this.activeStep = 2;
      return;
    }
    this.loading = true;
    this.issuanceConfigService
      .saveConfiguration(issuanceDto)
      .then(
        () => {
          this.snackBar.open(`Configuration saved successfully`, 'Close', { duration: 3000 });
          this.router.navigate(['../'], { relativeTo: this.route });
        },
        (error: unknown) => {
          openErrorSnackBar(
            this.snackBar,
            getApiErrorMessage(error, 'Failed to save configuration', { allIssues: true })
          );
        }
      )
      .finally(() => {
        this.loading = false;
      });
  }

  private buildFederationConfig(federationFormValue: unknown): IssuanceConfig['federation'] | null {
    if (!federationFormValue || typeof federationFormValue !== 'object') {
      return null;
    }
    const fVal = federationFormValue as Record<string, unknown>;
    const enabled = (fVal as any)['enabled'];
    const trustAnchors = (fVal as any)['trustAnchors'];
    if (!enabled || !Array.isArray(trustAnchors) || trustAnchors.length === 0) {
      return null;
    }
    const mode = this.normalizeFederationMode(fVal['mode']);
    // `role` and `enforceSigningPolicy` are not sent: EUDIPLO only acts as a
    // leaf entity and always enforces federation checks.
    return {
      ...this.federationEntitySettings,
      mode,
      // An empty entity ID means not set.
      entityId: (fVal['entityId'] as string | null) || undefined,
      cacheTtlSeconds: (fVal['cacheTtlSeconds'] as number) ?? 300,
      trustAnchors: trustAnchors as {
        entityId: string;
        entityConfigurationUri: string;
      }[],
    };
  }

  getFormGroup(controlName: string): FormGroup {
    return this.form.get(controlName) as FormGroup;
  }

  getControl(value: any): FormControl {
    return value as FormControl;
  }

  get displays(): FormArray {
    return this.form.get('display') as FormArray;
  }

  addDisplay(): void {
    const displayGroup = this.fb.group({
      name: ['', Validators.required],
      locale: ['en-US', Validators.required],
      logo: this.fb.group({
        uri: [''],
      }),
    });
    this.displays.push(displayGroup);
  }

  removeDisplay(index: number): void {
    this.displays.removeAt(index);
  }

  get authorizationServers(): FormArray {
    return this.form.get('authorizationServers') as FormArray;
  }

  private createAuthorizationServerGroup(value?: any): FormGroup {
    if (value?.type === 'external') {
      return this.fb.group({
        type: ['external', Validators.required],
        id: [value?.id ?? '', Validators.required],
        issuer: [value?.issuer ?? '', Validators.required],
        label: [value?.label ?? ''],
      });
    }

    if (value?.type === 'built-in') {
      return this.fb.group({
        type: ['built-in', Validators.required],
        id: [value?.id ?? 'issuer-built-in', Validators.required],
        label: [value?.label ?? 'Built-in Authorization Server', Validators.required],
        enabled: [value?.enabled ?? true],
        requireDPoP: [value?.requireDPoP ?? false],
        ...this.createAuthorizationServerWalletAttestationControls(value),
        token: this.fb.group({
          lifetimeSeconds: [
            value?.token?.lifetimeSeconds ?? defaultAccessTokenLifetimeSeconds('built-in'),
            Validators.min(60),
          ],
          signingKeyId: [value?.token?.signingKeyId ?? ''],
          refreshTokenEnabled: [value?.token?.refreshTokenEnabled ?? true],
          refreshTokenExpiresInSeconds: [
            value?.token?.refreshTokenExpiresInSeconds ?? 2592000,
            Validators.min(1),
          ],
        }),
      });
    }

    return this.fb.group({
      id: [value?.id ?? '', Validators.required],
      label: [value?.label ?? '', Validators.required],
      type: [value?.type ?? 'oid4vp', Validators.required],
      enabled: [value?.enabled ?? true],
      requireDPoP: [value?.requireDPoP ?? false],
      ...this.createAuthorizationServerWalletAttestationControls(value),
      oid4vp: this.fb.group({
        presentationConfigId: [value?.oid4vp?.presentationConfigId ?? ''],
        immediateWalletRedirect: [value?.oid4vp?.immediateWalletRedirect ?? true],
      }),
      chained: this.fb.group({
        issuer: [value?.chained?.issuer ?? ''],
        clientId: [value?.chained?.clientId ?? ''],
        clientSecret: [value?.chained?.clientSecret ?? ''],
        scopes: [value?.chained?.scopes ?? ['openid', 'profile', 'email']],
      }),
      token: this.fb.group({
        lifetimeSeconds: [
          value?.token?.lifetimeSeconds ?? defaultAccessTokenLifetimeSeconds(value?.type),
          Validators.min(60),
        ],
        signingKeyId: [value?.token?.signingKeyId ?? ''],
        refreshTokenEnabled: [value?.token?.refreshTokenEnabled ?? true],
        refreshTokenExpiresInSeconds: [
          value?.token?.refreshTokenExpiresInSeconds ?? 2592000,
          Validators.min(1),
        ],
      }),
    });
  }

  addExternalAuthorizationServer(): void {
    this.addAuthorizationServer();
  }

  addAuthorizationServer(): void {
    const server = this.createAuthorizationServerGroup();
    this.authorizationServers.push(server);
    this.expandedServers.add(server);
  }

  addChainedAuthorizationServer(): void {
    this.addAuthorizationServer();
  }

  addBuiltInAuthorizationServer(): void {
    this.addAuthorizationServer();
  }

  onAuthorizationServerTypeChange(
    index: number,
    type: 'external' | 'oid4vp' | 'chained' | 'built-in'
  ): void {
    const current = this.authorizationServers.at(index)?.getRawValue();
    if (!current) {
      return;
    }

    if (type === 'built-in' && this.hasBuiltInAuthorizationServer(index)) {
      this.snackBar.open('Only one built-in authorization server can be configured', 'Close', {
        duration: 3000,
      });
      this.authorizationServers.at(index).get('type')?.setValue('oid4vp', { emitEvent: false });
      type = 'oid4vp';
    }

    const nextValue: any = {
      ...current,
      type,
    };

    if (type === 'external') {
      nextValue.issuer = current.issuer ?? '';
      nextValue.label = current.label ?? '';
    }

    if (type === 'chained' && !nextValue.label) {
      nextValue.label = 'Chained Authorization Server';
    }

    if (type === 'built-in' && !nextValue.label) {
      nextValue.label = 'Built-in Authorization Server';
    }

    // Built-in and hosted servers have different token lifetime defaults; carry over only a
    // lifetime the user changed, not the previous type's default.
    const lifetime = current.token?.lifetimeSeconds;
    const lifetimeEdited = this.authorizationServers.at(index).get('token.lifetimeSeconds')?.dirty;
    const isDefaultLifetime =
      lifetime == null ||
      lifetime === defaultAccessTokenLifetimeSeconds('built-in') ||
      lifetime === defaultAccessTokenLifetimeSeconds('oid4vp');
    if (current.token && !lifetimeEdited && isDefaultLifetime) {
      nextValue.token = {
        ...current.token,
        lifetimeSeconds: defaultAccessTokenLifetimeSeconds(type),
      };
    }

    this.authorizationServers.setControl(index, this.createAuthorizationServerGroup(nextValue));
  }

  /**
   * True when `signingKeyId` names no access token key chain of the tenant, as a value stored
   * before 10.0 does; the authorization server's token requests then fail. False while unknown.
   */
  signingKeyIdInvalid(signingKeyId: string | null | undefined): boolean {
    return (
      !!signingKeyId &&
      !!this.accessTokenKeyChains &&
      !this.accessTokenKeyChains.some((keyChain) => keyChain.id === signingKeyId)
    );
  }

  /** True when `signingKeyId` is set but not among the listed access token key chains. */
  signingKeyIdUnlisted(signingKeyId: string | null | undefined): boolean {
    return (
      !!signingKeyId &&
      !(this.accessTokenKeyChains ?? []).some((keyChain) => keyChain.id === signingKeyId)
    );
  }

  /** Description and ID, as the wizard gives every key the same default description. */
  accessTokenKeyChainLabel(keyChain: { id: string; description?: string }): string {
    return keyChain.description ? `${keyChain.description} (${keyChain.id})` : keyChain.id;
  }

  accessTokenLifetimeDefault(type: string | undefined): number {
    return defaultAccessTokenLifetimeSeconds(type);
  }

  hasBuiltInAuthorizationServer(excludeIndex?: number): boolean {
    return this.authorizationServers.controls.some((control, index) => {
      if (excludeIndex !== undefined && index === excludeIndex) {
        return false;
      }
      return control.get('type')?.value === 'built-in';
    });
  }

  removeAuthorizationServer(index: number): void {
    this.authorizationServers.removeAt(index);
  }

  getAuthorizationServerWalletProviderTrustLists(index: number): FormArray {
    return this.authorizationServers.at(index).get('walletProviderTrustLists') as FormArray;
  }

  addAuthorizationServerWalletProviderTrustList(
    index: number,
    mode: WalletProviderTrustListMode
  ): void {
    this.addTrustListEntry(this.getAuthorizationServerWalletProviderTrustLists(index), mode);
  }

  moveAuthorizationServer(index: number, direction: 'up' | 'down'): void {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= this.authorizationServers.length) {
      return;
    }

    const current = this.authorizationServers.at(index);
    const target = this.authorizationServers.at(targetIndex);
    this.authorizationServers.setControl(index, target);
    this.authorizationServers.setControl(targetIndex, current);
  }

  get walletProviderTrustLists(): FormArray {
    return this.form.get('walletProviderTrustLists') as FormArray;
  }

  get federation(): FormGroup {
    return this.form.get('federation') as FormGroup;
  }

  get registrationCertificate(): FormGroup {
    return this.form.get('registrationCertificate') as FormGroup;
  }

  get registrationCertificateEnabled(): boolean {
    return this.registrationCertificate.get('enabled')?.value ?? false;
  }

  get registrationCertificateMode(): 'import' | 'generate' {
    return this.registrationCertificate.get('mode')?.value ?? 'generate';
  }

  /** Names of the entity configuration settings carried over unchanged. */
  get federationEntitySettingNames(): string[] {
    return Object.keys(this.federationEntitySettings);
  }

  get federationEnabled(): boolean {
    return this.federation.get('enabled')?.value ?? false;
  }

  get trustAnchors(): FormArray {
    return this.federation.get('trustAnchors') as FormArray;
  }

  /**
   * Entity IDs of trust anchors this edit adds that are not registered. The backend rejects
   * them; trust anchors of the stored configuration are kept, though not trusted.
   */
  get newUnregisteredTrustAnchors(): string[] {
    const registered = this.federationTrustAnchors.registeredEntityIds();
    if (!registered) return [];
    return this.trustAnchors.controls
      .map((anchor) => `${anchor.get('entityId')?.value ?? ''}`)
      .filter((id) => id && !registered.has(id) && !this.storedTrustAnchorIds.has(id));
  }

  /**
   * Fills in the entity configuration URI of a trust anchor the user picked, unless it holds
   * a URI other than the one derived from the entity ID it replaces.
   */
  onTrustAnchorSelected(
    index: number,
    { anchor, previous }: { anchor: FederationTrustAnchor; previous: string }
  ): void {
    const uri = this.trustAnchors.at(index).get('entityConfigurationUri');
    const current = `${uri?.value ?? ''}`.trim();
    if (!current || (previous && current === entityConfigurationUri(previous)))
      uri?.setValue(entityConfigurationUri(anchor.entityId));
  }

  addTrustAnchor(): void {
    this.trustAnchors.push(
      this.fb.group({
        entityId: ['', Validators.required],
        entityConfigurationUri: ['', Validators.required],
      })
    );
  }

  removeTrustAnchor(index: number): void {
    this.trustAnchors.removeAt(index);
  }

  addWalletProviderTrustList(mode: WalletProviderTrustListMode): void {
    this.addTrustListEntry(this.walletProviderTrustLists, mode);
  }

  private addTrustListEntry(trustLists: FormArray, mode: WalletProviderTrustListMode): void {
    trustLists.push(this.createWalletProviderTrustListGroup(undefined, mode));
    if (mode === 'managed') void this.loadTrustLists();
  }

  /** True when `trustLists` has a managed entry, which needs the tenant's lists. */
  hasManagedEntry(trustLists: FormArray): boolean {
    return trustLists.controls.some((entry) => entry.get('mode')?.value === 'managed');
  }

  removeTrustListEntry(trustLists: FormArray, index: number): void {
    trustLists.removeAt(index);
  }

  /** The control `name` of a trust list entry, for the shared entry template. */
  trustListControl(trustList: AbstractControl, name: string): FormControl {
    return trustList.get(name) as FormControl;
  }

  /** The tenant's trust lists that name a wallet provider, the only ones a wallet attestation can match. */
  get walletProviderTrustListOptions(): TrustList[] {
    return this.trustLists.filter((list) =>
      list.entityConfig?.some((entity) => entity['providerType'] === 'wallet-provider')
    );
  }

  /**
   * Why a stored managed list ID is not among the options, or null when it is
   * or nothing is selected. The select shows the ID with this note, so a
   * stored reference stays visible while the lists load or after they failed.
   */
  managedTrustListNote(id: string | null | undefined): string | null {
    if (!id) return null;
    if (!this.trustListsLoaded) return 'lists not loaded';
    if (this.walletProviderTrustListOptions.some((list) => list.id === id)) return null;
    return this.trustLists.some((list) => list.id === id) ? 'no wallet provider' : 'not found';
  }

  async loadTrustLists(): Promise<void> {
    if (this.trustListsLoading || this.trustListsLoaded) return;
    this.trustListsLoading = true;
    this.trustListsError = '';
    try {
      this.trustLists = await this.fetchTrustLists();
      this.trustListsLoaded = true;
    } catch (error) {
      this.trustListsError = `${asSentence(getApiErrorMessage(error, 'Could not load the trust lists of this tenant'))} Selected lists are kept; retry or add an external trust list.`;
    } finally {
      this.trustListsLoading = false;
    }
  }

  /** Overridden in tests. */
  protected fetchTrustLists(): Promise<TrustList[]> {
    return trustListControllerGetAllTrustLists().then((response) => response.data ?? []);
  }

  private markFormGroupTouched(): void {
    Object.keys(this.form.controls).forEach((key) => {
      const control = this.form.get(key);
      control?.markAsTouched();
    });
  }

  /**
   * Open JSON view dialog to show/edit the complete configuration
   */
  viewAsJson(): void {
    let currentConfig: UpdateIssuanceDto;
    try {
      currentConfig = this.buildConfigurationPayload();
    } catch {
      this.stepError = 'Fix the highlighted settings before opening JSON View.';
      return;
    }

    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Complete Configuration JSON',
        jsonData: currentConfig,
        readonly: false,
        schema: issuanceConfigSchema,
      },
      disableClose: true,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (result) {
        this.loadingConfig = true;
        try {
          await this.applyConfiguration(result);
        } finally {
          this.loadingConfig = false;
        }
      }
    });
  }
}
