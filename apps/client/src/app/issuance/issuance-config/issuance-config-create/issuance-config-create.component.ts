import { Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
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
import { IssuanceConfig, UpdateIssuanceDto } from '@eudiplo/sdk-core';
import {
  defaultAccessTokenLifetimeSeconds,
  IssuanceConfigService,
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
    RouterModule,
    MatSlideToggleModule,
    MatSlideToggle,
    ImageFieldComponent,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
  ],
  templateUrl: './issuance-config-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './issuance-config-create.component.scss',
})
export class IssuanceConfigCreateComponent implements OnInit {
  private static readonly SPKI_PEM_PATTERN =
    /^\s*-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/;

  private static jsonValidator(control: AbstractControl): ValidationErrors | null {
    const value = control.value as string;
    if (!value?.trim()) return null;
    try {
      JSON.parse(value);
      return null;
    } catch {
      return { invalidJson: true };
    }
  }

  private trustListVerifierValidator(control: AbstractControl): ValidationErrors | null {
    const value = control.value as {
      trustListId?: string;
      url?: string;
      verifierKey?: unknown;
      verifierKeyPem?: unknown;
      verifierX509Der?: unknown;
    };

    if (value?.trustListId?.trim()) return null;
    if (!value?.url?.trim()) return { missingUrl: true };
    const keyStr = value?.verifierKey;
    const hasVerifierKey = !!keyStr && typeof keyStr === 'string' && keyStr.trim().length > 0;
    const hasVerifierKeyPem =
      typeof value?.verifierKeyPem === 'string' && value.verifierKeyPem.trim().length > 0;
    const hasVerifierX509Der =
      !!value?.verifierX509Der &&
      typeof value.verifierX509Der === 'string' &&
      (value.verifierX509Der as string).trim().length > 0;

    return hasVerifierKey || hasVerifierKeyPem || hasVerifierX509Der
      ? null
      : { missingVerifier: true };
  }

  private createWalletProviderTrustListGroup(value?: {
    trustListId?: string;
    url?: string;
    verifierKey?: string;
    verifierKeyPem?: string;
    verifierX509Der?: string;
  }): FormGroup {
    return this.fb.group(
      {
        trustListId: [value?.trustListId ?? ''],
        url: [value?.url ?? ''],
        verifierKey: [value?.verifierKey ?? '', [IssuanceConfigCreateComponent.jsonValidator]],
        verifierKeyPem: [
          value?.verifierKeyPem ?? '',
          [Validators.pattern(IssuanceConfigCreateComponent.SPKI_PEM_PATTERN)],
        ],
        verifierX509Der: [value?.verifierX509Der ?? ''],
      },
      {
        validators: [this.trustListVerifierValidator.bind(this)],
      }
    );
  }

  private createWalletProviderTrustListArray(entries?: any[]): FormArray {
    const trustLists = this.fb.array<FormGroup>([]);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry === 'string') {
          trustLists.push(this.createWalletProviderTrustListGroup({ url: entry }));
          continue;
        }

        trustLists.push(
          this.createWalletProviderTrustListGroup({
            trustListId: entry?.trustListId ?? '',
            url: entry?.url ?? '',
            verifierKey:
              typeof entry?.verifierKey === 'string'
                ? entry.verifierKey
                : entry?.verifierKey
                  ? JSON.stringify(entry.verifierKey, null, 2)
                  : '',
            verifierKeyPem: entry?.verifierKeyPem ?? '',
            verifierX509Der: entry?.verifierX509Der ?? '',
          })
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
      inheritWalletProviderTrustLists: inherit,
      walletProviderTrustLists: trustLists,
    };
  }

  private buildWalletProviderTrustLists(value: any[] | undefined): any[] {
    return value?.length
      ? value
          .map((entry: any) => {
            if (entry?.trustListId?.trim()) return { trustListId: entry.trustListId.trim() };
            let verifierKey: Record<string, unknown> | undefined;
            if (typeof entry?.verifierKey === 'string' && entry.verifierKey.trim()) {
              verifierKey = JSON.parse(entry.verifierKey) as Record<string, unknown>;
            }

            return {
              url: entry?.url?.trim() || undefined,
              verifierKey,
              verifierKeyPem: entry?.verifierKeyPem?.trim() || undefined,
              verifierX509Der: entry?.verifierX509Der?.trim() || undefined,
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

  get behaviorSummary(): string {
    const value = this.form.value;
    return `Batch size: ${value.batchSize} · DPoP: ${value.dPopRequired ? 'Required' : 'Optional'} · Request encryption: ${value.credentialRequestEncryption ? 'Required' : 'Off'} · Response encryption: ${value.credentialResponseEncryption ? 'Advertised' : 'Off'} · Notifications: ${value.notificationEndpointEnabled ? 'On' : 'Off'}`;
  }

  get trustSummary(): string {
    return `Wallet attestation default: ${this.form.get('walletAttestationRequired')?.value ? 'Required' : 'Optional'} · Wallet provider trust lists: ${this.walletProviderTrustLists.length} · Federation: ${this.federationEnabled ? 'On' : 'Off'} · Registration certificate: ${this.registrationCertificateEnabled ? this.registrationCertificateMode : 'Off'} · PIN attempt limit: ${this.form.get('txCodeMaxAttempts')?.value ?? 5}`;
  }

  public form: FormGroup;
  public loading = false;
  public availablePresentationConfigIds: string[] = [];
  private readonly federationModes = ['federation-only', 'hybrid'] as const;
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
    private readonly registrarService: RegistrarService
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
      walletProviderTrustLists: this.fb.array([]),
      federation: this.fb.group({
        enabled: [false],
        mode: ['hybrid'],
        entityId: [''],
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
    const updateFederationValidation = () => {
      if (this.federationEnabled) this.trustAnchors.enable({ emitEvent: false });
      else this.trustAnchors.disable({ emitEvent: false });
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
    }, 0);
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
    } catch {
      this.snackBar.open('Failed to load registrar defaults', 'Close', {
        duration: 3000,
      });
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
      await this.applyConfiguration(config);
      // No identity yet: offer the onboarding flow while retaining the server defaults.
      this.guidedMode =
        !config.display?.length || this.route.snapshot.queryParamMap?.get('setup') === 'true';
      if (!this.displays.length) this.addDisplay();
    } catch {
      this.loadError = 'Could not load issuer settings. Retry before making changes.';
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
    const walletTrustListsArray = this.form.get('walletProviderTrustLists') as FormArray;
    walletTrustListsArray.clear();
    if (config.walletProviderTrustLists && Array.isArray(config.walletProviderTrustLists)) {
      for (const entry of config.walletProviderTrustLists as any[]) {
        if (typeof entry === 'string') {
          walletTrustListsArray.push(this.createWalletProviderTrustListGroup({ url: entry }));
          continue;
        }

        walletTrustListsArray.push(
          this.createWalletProviderTrustListGroup({
            trustListId: entry?.trustListId ?? '',
            url: entry?.url ?? '',
            verifierKey:
              entry?.verifierKey && typeof entry.verifierKey === 'object'
                ? JSON.stringify(entry.verifierKey, null, 2)
                : '',
            verifierKeyPem: typeof entry?.verifierKeyPem === 'string' ? entry.verifierKeyPem : '',
            verifierX509Der:
              typeof entry?.verifierX509Der === 'string' ? entry.verifierX509Der : '',
          })
        );
      }
    }

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
    this.federation.patchValue({
      enabled: false,
      mode: 'hybrid',
      entityId: '',
      cacheTtlSeconds: 300,
    });
    // Load Federation config if present
    if (config && (config as any)['federation']) {
      const federation = (config as any)['federation'];
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
                  clientSecret: server.chained?.clientSecret,
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
      this.stepError = 'Check the JSON in your trust settings.';
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
        (error: string) => {
          this.snackBar.open(`Failed to save configuration: ${error}`, 'Close', {
            duration: 3000,
          });
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
      mode,
      entityId: (fVal['entityId'] as string) ?? undefined,
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

  addAuthorizationServerWalletProviderTrustList(index: number): void {
    this.getAuthorizationServerWalletProviderTrustLists(index).push(
      this.createWalletProviderTrustListGroup()
    );
  }

  removeAuthorizationServerWalletProviderTrustList(index: number, trustListIndex: number): void {
    this.getAuthorizationServerWalletProviderTrustLists(index).removeAt(trustListIndex);
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

  get federationEnabled(): boolean {
    return this.federation.get('enabled')?.value ?? false;
  }

  get trustAnchors(): FormArray {
    return this.federation.get('trustAnchors') as FormArray;
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

  addWalletProviderTrustList(): void {
    this.walletProviderTrustLists.push(this.createWalletProviderTrustListGroup());
  }

  removeWalletProviderTrustList(index: number): void {
    this.walletProviderTrustLists.removeAt(index);
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
      this.stepError = 'Fix invalid trust-list JSON before opening JSON view.';
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
