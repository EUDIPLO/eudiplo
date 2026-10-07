import { Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import {
  AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  CredentialConfigCreate,
  ClaimFieldDefinitionDto,
  FieldDisplayDto,
  keyChainControllerGetAll,
  KeyChainResponseDto,
  PresentationConfig,
  IaeActionOpenid4VpPresentation,
  IaeActionRedirectToWeb,
  attributeProviderControllerGetAll,
  webhookEndpointControllerGetAll,
  AttributeProviderEntity,
  WebhookEndpointEntity,
} from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../../../presentation/presentation-config/presentation-management.service';
import { CredentialConfigService } from '../credential-config.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { JsonViewDialogComponent } from './json-view-dialog/json-view-dialog.component';
import { configs } from './pre-config';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import {
  credentialConfigSchema,
  embeddedDisclosurePolicySchema,
  vctSchema,
} from '../../../utils/schemas';
import { EditorComponent, extractSchema } from '../../../utils/editor/editor.component';
import { ImageFieldComponent } from '../../../utils/image-field/image-field.component';
import { schemaFormValidator } from '../../../utils/schema-form-validator';
import { getApiErrorMessage } from '../../../utils/error-message';
import { hostedVctUrl } from '../../../utils/public-url';
import { FrontendConfigService } from '../../../services/frontend-config.service';
import { JwtService } from '../../../services/jwt.service';

@Component({
  selector: 'app-credential-config-create',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatDialogModule,
    MatDividerModule,
    MatMenuModule,
    MatTabsModule,
    MatTooltipModule,
    FlexLayoutModule,
    MatSlideToggleModule,
    MatExpansionModule,
    ReactiveFormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    MonacoEditorModule,
    EditorComponent,
    ImageFieldComponent,
    DragDropModule,
  ],
  templateUrl: './credential-config-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './credential-config-create.component.scss',
})
export class CredentialConfigCreateComponent implements OnInit {
  readonly defaultProofTypesSupported: ('attestation' | 'jwt')[] = ['attestation', 'jwt'];
  readonly proofTypeOptions: { value: 'attestation' | 'jwt'; label: string }[] = [
    { value: 'attestation', label: 'Attestation (preferred)' },
    { value: 'jwt', label: 'JWT' },
  ];

  public form: FormGroup;
  public create = true;
  public loading = false;
  public submitAttempted = false;
  guidedMode = true;
  activeStep = 0;
  furthestStep = 0;
  stepError = '';
  settingsExpanded = false;
  expandedFields = new Set<AbstractControl>();
  expandedAppearance = new Set<AbstractControl>();
  readonly stepNames = ['Basics', 'Claims', 'Appearance', 'Settings', 'Review'];

  private stepControls(step: number): string[] {
    const basics = ['id', 'description', 'format', 'vct', 'vctString', 'docType'];
    if (step === 0) return basics;
    if (step === 1) return ['fields'];
    if (step === 2) return ['displayConfigs'];
    return Object.keys(this.form.controls).filter(
      (name) => ![...basics, 'fields', 'displayConfigs'].includes(name)
    );
  }

  private validateStep(step: number): boolean {
    const invalid = this.stepControls(step).filter((name) => this.form.get(name)?.invalid);
    if (!invalid.length) return true;
    invalid.forEach((name) => this.form.get(name)?.markAllAsTouched());
    this.submitAttempted = true;
    if (step === 3) this.settingsExpanded = true;
    if (step === 2)
      this.displayConfigs.controls
        .filter((display) => display.invalid)
        .forEach((display) => this.expandedAppearance.add(display));
    if (step === 1)
      this.fields.controls
        .filter((field) => field.invalid)
        .forEach((field) => this.expandedFields.add(field));
    this.stepError = `Check the highlighted fields in ${this.stepNames[step]} before continuing.`;
    this.activeStep = step;
    return false;
  }

  nextStep(): void {
    this.stepError = '';
    if (this.loading || !this.validateStep(this.activeStep)) return;
    if (this.activeStep === 3) {
      for (let step = 0; step < 3; step++) if (!this.validateStep(step)) return;
    }
    this.activeStep = Math.min(4, this.activeStep + 1);
    this.furthestStep = Math.max(this.furthestStep, this.activeStep);
  }

  previousStep(): void {
    this.activeStep = Math.max(0, this.activeStep - 1);
    this.stepError = '';
  }

  toggleGuidedMode(): void {
    this.guidedMode = !this.guidedMode;
    this.activeStep = 0;
    this.furthestStep = 0;
    this.stepError = '';
  }

  onInputEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.isComposing || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return;
    key.preventDefault();
    key.stopPropagation();
    this.submitCredential();
  }

  submitCredential(): void {
    if (this.loading) return;
    if (this.guidedMode && this.activeStep < 4) this.nextStep();
    else this.onSubmit();
  }

  get settingsSummary(): string {
    const value = this.form.getRawValue();
    return `Lifetime: ${this.formatLifetime(value.lifeTime)} · Signing: ${value.keyChainId || 'Default key chain'} · Holder binding: ${value.keyBinding ? 'On' : 'Off'} · Status management: ${value.statusManagement ? 'On' : 'Off'} · Trust: ${this.isMdocFormat ? 'mDOC certificate chain' : value.sdJwtTrustFormat} · Proofs: ${value.proofTypesSupported.join(', ')} · Credential reuse: ${value.credentialReusePolicyEnabled ? value.credentialReusePolicyDetails.join(', ') : 'Not configured'}`;
  }

  keyChains: KeyChainResponseDto[] = [];
  presentationConfigs: PresentationConfig[] = [];
  attributeProviders: AttributeProviderEntity[] = [];
  webhookEndpoints: WebhookEndpointEntity[] = [];

  predefinedConfigs = configs;

  // Lifetime presets in seconds
  lifetimePresets = [
    { label: '1 hour', value: 3600 },
    { label: '8 hours', value: 28800 },
    { label: '1 day', value: 86400 },
    { label: '7 days', value: 604800 },
    { label: '30 days', value: 2592000 },
    { label: '1 year', value: 31536000 },
    { label: 'Custom', value: null },
  ];

  // Common mDOC document types
  docTypePresets = [
    {
      label: 'Mobile Driving License (mDL)',
      value: 'org.iso.18013.5.1.mDL',
    },
    { label: 'EU PID', value: 'eu.europa.ec.eudi.pid.1' },
    { label: 'EU mDL', value: 'org.iso.18013.5.1.mDL' },
    { label: 'Custom', value: '' },
  ];

  selectedLifetimePreset: number | null = 3600;
  customLifetime = false;

  // Key attestation presets (HAIP-compliant values)
  keyAttestationPresets = [
    { label: 'ISO 18045 High', value: 'iso_18045_high' },
    { label: 'ISO 18045 Moderate', value: 'iso_18045_moderate' },
  ];

  private readonly validateVct = schemaFormValidator(vctSchema);
  vctSchema = vctSchema;
  embeddedDisclosurePolicySchema = embeddedDisclosurePolicySchema;

  readonly localeOptions = [
    { value: 'en-US', label: 'English (United States)' },
    { value: 'en-GB', label: 'English (United Kingdom)' },
    { value: 'de-DE', label: 'German (Germany)' },
    { value: 'fr-FR', label: 'French (France)' },
    { value: 'it-IT', label: 'Italian (Italy)' },
    { value: 'es-ES', label: 'Spanish (Spain)' },
  ];

  readonly fieldTypes: ClaimFieldDefinitionDto['type'][] = [
    'string',
    'number',
    'integer',
    'boolean',
    'object',
    'array',
  ];

  // VCT mode: 'string' for simple URI, 'object' for metadata object
  vctMode: 'string' | 'object' = 'string';

  /** The backend's PUBLIC_URL and the tenant, for the hosted VCT URI; null until known. */
  private publicUrl: string | null = null;
  private tenantId: string | null = null;

  get isMdocFormat(): boolean {
    return this.form.get('format')?.value === 'mso_mdoc';
  }

  constructor(
    private readonly credentialConfigService: CredentialConfigService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog,
    private readonly presentationManagementService: PresentationManagementService,
    private readonly frontendConfigService: FrontendConfigService,
    private readonly jwtService: JwtService
  ) {
    this.form = new FormGroup({
      id: new FormControl('', [Validators.required]),
      description: new FormControl('', Validators.required),
      format: new FormControl('dc+sd-jwt', [Validators.required]),
      keyChainId: new FormControl(''),
      scope: new FormControl(''),
      lifeTime: new FormControl(3600, [Validators.min(1)]),
      keyBinding: new FormControl(true, [Validators.required]),
      statusManagement: new FormControl(true, [Validators.required]),
      activeCredentialsEnabled: new FormControl(false),
      // SD-JWT specific fields
      vct: new FormControl('', (control) =>
        control.parent?.get('format')?.value === 'mso_mdoc' ? null : this.validateVct(control)
      ),
      vctString: new FormControl(''),
      sdJwtTrustFormat: new FormControl('x5c'),
      // mDOC specific fields
      docType: new FormControl(''),
      fields: new FormArray([]),
      displayConfigs: new FormArray([this.createDisplayConfigGroup()]),
      embeddedDisclosurePolicy: new FormControl(
        '',
        schemaFormValidator(embeddedDisclosurePolicySchema)
      ),
      attributeProviderId: new FormControl(''),
      webhookEndpointId: new FormControl(''),
      iaeActions: new FormArray([]),
      // Key attestation requirements (per-credential, HAIP compliance)
      keyAttestationEnabled: new FormControl(false),
      keyStorageTypes: new FormControl<string[]>([]),
      userAuthenticationTypes: new FormControl<string[]>([]),
      proofTypesSupported: new FormControl<('attestation' | 'jwt')[]>(
        this.defaultProofTypesSupported,
        [Validators.required, Validators.minLength(1)]
      ),
      credentialReusePolicyEnabled: new FormControl(false),
      credentialReusePolicyDetails: new FormControl<string[]>(['once_only']),
      credentialReusePolicyBatchSize: new FormControl(10, [Validators.min(2)]),
      credentialReusePolicyReissueTriggerUnused: new FormControl(2, [Validators.min(0)]),
      credentialReusePolicyReissueTriggerLifetimeLeft: new FormControl(86400, [Validators.min(0)]),
    } as { [k in keyof Omit<CredentialConfigCreate, 'config'>]: any });

    // Set initial validator for vctString based on default mode
    if (this.vctMode === 'string') {
      this.form.get('vctString')?.setValidators([Validators.required]);
      this.form.get('vctString')?.updateValueAndValidity();
    }

    // Listen for format changes to update validators
    this.form.get('format')?.valueChanges.subscribe((format) => {
      this.form.get('vct')?.updateValueAndValidity();
      this.form.get('docType')?.setValidators(format === 'mso_mdoc' ? [Validators.required] : []);
      this.form.get('docType')?.updateValueAndValidity();
      const vctStringControl = this.form.get('vctString');
      if (format === 'mso_mdoc') {
        // mDOC doesn't need vctString - clear validators
        vctStringControl?.clearValidators();
      } else {
        // SD-JWT needs vctString when in string mode
        if (this.vctMode === 'string') {
          vctStringControl?.setValidators([Validators.required]);
        }
      }
      vctStringControl?.updateValueAndValidity();
    });

    this.form
      .get('activeCredentialsEnabled')
      ?.valueChanges.subscribe(() => this.syncStatusManagementWithActiveCredentials());

    if (this.route.snapshot.params['id']) {
      this.create = false;
      this.guidedMode = false;
    }
  }
  ngOnInit() {
    // Load only attestation key chains for signing certificate selection
    keyChainControllerGetAll({ query: { usageType: 'attestation' } }).then(
      (res) => (this.keyChains = res.data || []),
      (error) => {
        console.error('Failed to load key chains:', error);
        this.snackBar.open('Failed to load key chains', 'Close', {
          duration: 3000,
        });
      }
    );

    // Load presentation configurations for IAE
    this.presentationManagementService.loadConfigurations().then(
      (configs) => (this.presentationConfigs = configs || []),
      (error) => {
        console.error('Failed to load presentation configs:', error);
      }
    );

    // Load attribute providers for selection
    attributeProviderControllerGetAll({}).then(
      (res) => (this.attributeProviders = (res.data || []) as AttributeProviderEntity[]),
      (error) => {
        console.error('Failed to load attribute providers:', error);
      }
    );

    // Load webhook endpoints for selection
    webhookEndpointControllerGetAll({}).then(
      (res) => (this.webhookEndpoints = (res.data || []) as WebhookEndpointEntity[]),
      (error) => {
        console.error('Failed to load webhook endpoints:', error);
      }
    );

    // The hosted VCT URI starts with the backend's PUBLIC_URL, not the instance URL.
    this.tenantId = this.jwtService.getTenantId();
    this.frontendConfigService
      .getConfig()
      .then((config) => (this.publicUrl = config?.publicUrl ?? null));

    const id = this.route.snapshot.params['id'];
    if (!id) {
      return;
    }
    this.credentialConfigService.getConfig(id).then(
      (config) => {
        if (!config) {
          this.snackBar.open('Config not found', 'Close', {
            duration: 3000,
          });
          this.router.navigate(['../'], { relativeTo: this.route });
          return;
        }

        this.patchFormFromConfig(config);
        this.form.get('id')?.disable();
      },
      (error) => {
        console.error('Error loading key:', error);
        this.snackBar.open('Failed to load key', 'Close', {
          duration: 3000,
        });
      }
    );
  }

  onSubmit() {
    if (this.loading) return;
    this.submitAttempted = true;
    this.stepError = '';
    for (let step = 0; step < 4; step++) if (!this.validateStep(step)) return;

    if (this.form.invalid) {
      this.markFormGroupTouched();
      const invalidFields = this.getInvalidFields();
      this.snackBar.open(`Please fix invalid fields: ${invalidFields.join(', ')}`, 'Close', {
        duration: 5000,
      });
      console.log('Invalid fields:', invalidFields);
      return;
    }

    // Additional validation for SD-JWT: VCT URI is required
    const isMdoc = this.form.get('format')?.value === 'mso_mdoc';
    if (!isMdoc && this.vctMode === 'string') {
      const vctString = this.form.get('vctString')?.value?.trim();
      if (!vctString) {
        this.form.get('vctString')?.setErrors({ required: true });
        this.form.get('vctString')?.markAsTouched();
        this.snackBar.open('VCT URI is required for SD-JWT credentials', 'Close', {
          duration: 3000,
        });
        return;
      }
    }

    this.loading = true;

    try {
      const formValue = this.buildConfigurationPayload();
      const configId = this.route.snapshot.params['id'];

      const savePromise = this.create
        ? this.credentialConfigService.saveConfiguration(formValue)
        : this.credentialConfigService.updateConfiguration(configId, formValue);

      savePromise
        .then(
          () => {
            this.snackBar.open(
              `Configuration ${this.create ? 'created' : 'updated'} successfully`,
              'Close',
              { duration: 3000 }
            );
            this.router.navigate(['../'], { relativeTo: this.route });
          },
          (error) => {
            console.error('Error saving configuration:', error);
            this.snackBar.open(getApiErrorMessage(error, 'Failed to save configuration'), 'Close', {
              duration: 3000,
            });
          }
        )
        .finally(() => {
          this.loading = false;
        });
    } catch {
      this.snackBar.open('Invalid JSON format in one of the fields', 'Close', {
        duration: 3000,
      });
      this.loading = false;
    }
  }

  private countInvalidControls(control: AbstractControl | null): number {
    if (!control) {
      return 0;
    }

    if (control instanceof FormControl) {
      return control.invalid ? 1 : 0;
    }

    if (control instanceof FormGroup || control instanceof FormArray) {
      return Object.values(control.controls).reduce(
        (sum, child) => sum + this.countInvalidControls(child),
        0
      );
    }

    return 0;
  }

  private metadataInvalidCount(): number {
    return this.stepControls(0).reduce(
      (sum, name) => sum + this.countInvalidControls(this.form.get(name)),
      0
    );
  }
  private businessInvalidCount(): number {
    return this.stepControls(3).reduce(
      (sum, name) => sum + this.countInvalidControls(this.form.get(name)),
      0
    );
  }
  private visualInvalidCount(): number {
    return this.countInvalidControls(this.form.get('displayConfigs'));
  }
  private fieldsInvalidCount(): number {
    return this.countInvalidControls(this.form.get('fields'));
  }

  getTabInvalidCount(tab: 'metadata' | 'business' | 'display' | 'fields'): number {
    switch (tab) {
      case 'metadata':
        return this.metadataInvalidCount();
      case 'business':
        return this.businessInvalidCount();
      case 'display':
        return this.visualInvalidCount();
      case 'fields':
        return this.fieldsInvalidCount();
      default:
        return 0;
    }
  }

  showTabError(tab: 'metadata' | 'business' | 'display' | 'fields'): boolean {
    if (this.getTabInvalidCount(tab) === 0) {
      return false;
    }

    return (
      this.submitAttempted ||
      this.tabHasUserVisibleErrors(tab) ||
      (this.form.invalid && this.form.dirty)
    );
  }

  private hasTouchedOrDirtyInvalid(control: AbstractControl | null): boolean {
    if (!control) {
      return false;
    }

    if (control instanceof FormControl) {
      return control.invalid && (control.touched || control.dirty);
    }

    if (control instanceof FormGroup || control instanceof FormArray) {
      return Object.values(control.controls).some((child) => this.hasTouchedOrDirtyInvalid(child));
    }

    return false;
  }

  private tabHasUserVisibleErrors(tab: 'metadata' | 'business' | 'display' | 'fields'): boolean {
    switch (tab) {
      case 'metadata': {
        const hasBaseErrors = ['id', 'description', 'format', 'lifeTime'].some((name) =>
          this.hasTouchedOrDirtyInvalid(this.form.get(name))
        );

        const isMdoc = this.form.get('format')?.value === 'mso_mdoc';
        const hasVctErrors =
          !isMdoc && this.vctMode === 'string'
            ? this.hasTouchedOrDirtyInvalid(this.form.get('vctString'))
            : false;

        return hasBaseErrors || hasVctErrors;
      }
      case 'business':
        return this.hasTouchedOrDirtyInvalid(this.form.get('iaeActions'));
      case 'display':
        return this.hasTouchedOrDirtyInvalid(this.form.get('displayConfigs'));
      case 'fields':
        return this.hasTouchedOrDirtyInvalid(this.form.get('fields'));
      default:
        return false;
    }
  }

  getFormGroup(controlName: string): FormGroup {
    return this.form.get(controlName) as FormGroup;
  }

  getControl(value: any) {
    return value as FormControl;
  }

  /**
   * Single Active Credential revokes earlier credentials via the status list, so status
   * management is forced on (and locked) while it is enabled.
   */
  private syncStatusManagementWithActiveCredentials(): void {
    const statusManagement = this.form.get('statusManagement');
    if (this.form.get('activeCredentialsEnabled')?.value) {
      statusManagement?.setValue(true);
      statusManagement?.disable();
    } else {
      statusManagement?.enable();
    }
  }

  /**
   * Patch form with configuration data (reusable for edit mode and JSON load)
   */
  private patchFormFromConfig(config: CredentialConfigCreate): void {
    const normalizedConfig = config;

    // Determine VCT mode based on the type of vct value
    if (normalizedConfig.vct) {
      if (typeof normalizedConfig.vct === 'string') {
        this.vctMode = 'string';
      } else {
        this.vctMode = 'object';
      }
    }

    // Update vctString validators based on mode
    const vctStringControl = this.form.get('vctString');
    if (this.vctMode === 'string') {
      vctStringControl?.setValidators([Validators.required]);
    } else {
      vctStringControl?.clearValidators();
    }
    vctStringControl?.updateValueAndValidity();

    this.form.patchValue({
      id: normalizedConfig.id || '',
      keyChainId: normalizedConfig.keyChainId || '',
      format: normalizedConfig.config?.format || 'dc+sd-jwt',
      scope: normalizedConfig.config?.scope || '',
      description: normalizedConfig.description || '',
      lifeTime: normalizedConfig.lifeTime || 3600,
      keyBinding: normalizedConfig.keyBinding ?? true,
      statusManagement: normalizedConfig.statusManagement ?? true,
      activeCredentialsEnabled: normalizedConfig.activeCredentials?.enabled ?? false,
      attributeProviderId: normalizedConfig.attributeProviderId || '',
      webhookEndpointId: normalizedConfig.webhookEndpointId || '',
      // SD-JWT specific
      vct:
        typeof normalizedConfig.vct === 'object' ? this.stringifyField(normalizedConfig.vct) : '',
      vctString: typeof normalizedConfig.vct === 'string' ? normalizedConfig.vct : '',
      sdJwtTrustFormat: (normalizedConfig as any).sdJwtTrustFormat || 'x5c',
      // mDOC specific
      docType: normalizedConfig.config?.docType || '',
      displayConfigs: normalizedConfig.config?.display || [],
      embeddedDisclosurePolicy: this.stringifyField(normalizedConfig.embeddedDisclosurePolicy),
      // Key attestation requirements
      keyAttestationEnabled: !!(normalizedConfig.config as any)?.keyAttestationsRequired,
      keyStorageTypes: (normalizedConfig.config as any)?.keyAttestationsRequired?.key_storage || [],
      userAuthenticationTypes:
        (normalizedConfig.config as any)?.keyAttestationsRequired?.user_authentication || [],
      proofTypesSupported: (() => {
        const configuredProofTypes = (normalizedConfig.config as any)?.proofTypesSupported;
        return Array.isArray(configuredProofTypes) && configuredProofTypes.length > 0
          ? configuredProofTypes
          : this.defaultProofTypesSupported;
      })(),
      credentialReusePolicyEnabled: !!(normalizedConfig.config as any)?.credentialReusePolicy,
      credentialReusePolicyDetails: (normalizedConfig.config as any)?.credentialReusePolicy
        ?.options?.[0]?.details || ['once_only'],
      credentialReusePolicyBatchSize:
        (normalizedConfig.config as any)?.credentialReusePolicy?.options?.[0]?.batch_size || 10,
      credentialReusePolicyReissueTriggerUnused:
        (normalizedConfig.config as any)?.credentialReusePolicy?.options?.[0]
          ?.reissue_trigger_unused || 2,
      credentialReusePolicyReissueTriggerLifetimeLeft:
        (normalizedConfig.config as any)?.credentialReusePolicy?.options?.[0]
          ?.reissue_trigger_lifetime_left || 86400,
    } as any);
    this.syncStatusManagementWithActiveCredentials();

    const flatFields = this.flattenFieldDefinitionsForForm(normalizedConfig.fields || []);
    this.fields.clear();
    for (const field of flatFields) {
      this.fields.push(this.createFieldGroup(field));
    }

    // Handle IAE actions
    this.iaeActions.clear();
    if (normalizedConfig.iaeActions?.length) {
      normalizedConfig.iaeActions.forEach((action) =>
        this.iaeActions.push(this.createIaeActionGroup(action))
      );
    }

    // Update lifetime preset selection
    this.updateLifetimePresetFromValue(normalizedConfig.lifeTime || 3600);
  }

  /**
   * Update lifetime preset selection based on value
   */
  private updateLifetimePresetFromValue(value: number): void {
    const preset = this.lifetimePresets.find((p) => p.value === value);
    if (preset) {
      this.selectedLifetimePreset = preset.value;
      this.customLifetime = false;
    } else {
      this.selectedLifetimePreset = null;
      this.customLifetime = true;
    }
  }

  /**
   * Handle lifetime preset selection
   */
  onLifetimePresetChange(presetValue: number | null): void {
    this.selectedLifetimePreset = presetValue;
    if (presetValue === null) {
      this.customLifetime = true;
    } else {
      this.customLifetime = false;
      this.form.get('lifeTime')?.setValue(presetValue);
    }
  }

  /**
   * Handle VCT mode change
   */
  onVctModeChange(mode: 'string' | 'object'): void {
    this.vctMode = mode;
    const vctStringControl = this.form.get('vctString');
    if (mode === 'string') {
      // Clear the vct object field when switching to string mode
      this.form.get('vct')?.setValue('');
      // Add required validator for vctString
      vctStringControl?.setValidators([Validators.required]);
    } else {
      // Clear the vctString field when switching to object mode
      // The vct URL will be auto-generated by EUDIPLO, user only provides other metadata
      vctStringControl?.setValue('');
      // Remove required validator for vctString
      vctStringControl?.clearValidators();
    }
    vctStringControl?.updateValueAndValidity();
  }

  /**
   * Get the auto-generated VCT URI based on the credential config ID. Placeholders stand for
   * the public URL until the frontend configuration is loaded, and for a tenant the token
   * does not name.
   */
  getVctUri(): string {
    const configId = this.form.get('id')?.value || '<credential-id>';
    return hostedVctUrl(this.publicUrl ?? '<PUBLIC_URL>', this.tenantId ?? '<tenantId>', configId);
  }

  /**
   * Handle docType preset selection
   */
  onDocTypePresetChange(preset: { value: string }): void {
    this.form.get('docType')?.setValue(preset.value);
  }

  /**
   * Format lifetime value for display
   */
  formatLifetime(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days`;
    if (seconds < 2592000) return `${Math.floor(seconds / 604800)} weeks`;
    if (seconds < 31536000) return `${Math.floor(seconds / 2592000)} months`;
    return `${Math.floor(seconds / 31536000)} years`;
  }

  private markControlTreeTouched(control: AbstractControl | null): void {
    if (!control) {
      return;
    }

    control.markAsTouched();

    if (control instanceof FormGroup || control instanceof FormArray) {
      Object.values(control.controls).forEach((child) => this.markControlTreeTouched(child));
    }
  }

  private markFormGroupTouched(): void {
    this.markControlTreeTouched(this.form);
  }

  /**
   * Get list of invalid field names for debugging
   */
  private getInvalidFields(): string[] {
    const invalidFields: string[] = [];
    Object.keys(this.form.controls).forEach((key) => {
      const control = this.form.get(key);
      if (control?.invalid) {
        // Check if it's a FormArray (like displayConfigs)
        if (control instanceof FormArray) {
          control.controls.forEach((group, index) => {
            if (group instanceof FormGroup) {
              Object.keys(group.controls).forEach((childKey) => {
                if (group.get(childKey)?.invalid) {
                  invalidFields.push(`${key}[${index}].${childKey}`);
                }
              });
            }
          });
        } else {
          invalidFields.push(key);
        }
      }
    });
    return invalidFields;
  }

  // Display Configuration Management
  createDisplayConfigGroup(): FormGroup {
    return new FormGroup({
      name: new FormControl('', [Validators.required]),
      description: new FormControl('', [Validators.required]),
      locale: new FormControl('en-US', [Validators.required]),
      background_color: new FormControl('#FFFFFF'),
      text_color: new FormControl('#000000'),
      // Handle both nested (from API/JSON) and flattened (from form) formats
      background_image: new FormGroup({
        uri: new FormControl(''),
      }),
      logo: new FormGroup({
        uri: new FormControl(''),
      }),
    });
  }

  get displayConfigs(): FormArray {
    return this.form.get('displayConfigs') as FormArray;
  }

  addDisplayConfig(): void {
    this.displayConfigs.push(this.createDisplayConfigGroup());
  }

  removeDisplayConfig(index: number): void {
    if (this.displayConfigs.length > 1) {
      this.displayConfigs.removeAt(index);
    }
  }

  // Field Definition Management
  createFieldDisplayGroup(display?: FieldDisplayDto): FormGroup {
    const displayEntry = display as FieldDisplayDto;

    return new FormGroup({
      locale: new FormControl(displayEntry?.locale || 'en-US', [Validators.required]),
      name: new FormControl(displayEntry?.name || '', [Validators.required]),
      description: new FormControl(display?.description || ''),
    });
  }

  createFieldGroup(field?: ClaimFieldDefinitionDto): FormGroup {
    const display = new FormArray(
      (field?.display || []).map((entry) => this.createFieldDisplayGroup(entry))
    );
    const namespace = this.getFieldNamespaceForForm(field);

    const group = new FormGroup({
      path: new FormControl(this.normalizeFieldPathForForm(field), [Validators.required]),
      namespace: new FormControl(namespace),
      type: new FormControl(field?.type || 'string', [Validators.required]),
      defaultValue: new FormControl(
        typeof field?.defaultValue === 'string' && field.type === 'string'
          ? field.defaultValue
          : field?.defaultValue === undefined
            ? ''
            : JSON.stringify(field.defaultValue, null, 2)
      ),
      mandatory: new FormControl(!!field?.mandatory),
      disclosable: new FormControl(field?.disclosable ?? true),
      display,
    });
    group.controls.defaultValue.addValidators((control) => {
      try {
        this.parseClaimDefault(control.value, group.controls.type.value || 'string');
        return null;
      } catch (error) {
        return { defaultValueType: (error as Error).message };
      }
    });
    group.controls.type.valueChanges.subscribe(() =>
      group.controls.defaultValue.updateValueAndValidity()
    );
    group.controls.defaultValue.updateValueAndValidity();
    return group;
  }

  claimDefaultHint(type: string): string {
    switch (type) {
      case 'string':
        return 'Plain text, e.g. Max. No quotes needed. Leave empty for no default.';
      case 'boolean':
        return 'Enter true or false. Leave empty for no default.';
      case 'number':
        return 'Enter a number, e.g. 42 or 3.14. Leave empty for no default.';
      case 'integer':
        return 'Enter a whole number, e.g. 42. Leave empty for no default.';
      case 'object':
        return 'Enter a JSON object, e.g. {"city":"Berlin"}. Leave empty for no default.';
      default:
        return 'Enter a JSON array, e.g. ["one", "two"]. Leave empty for no default.';
    }
  }

  private parseClaimDefault(
    value: string | null | undefined,
    type: string
  ): ClaimFieldDefinitionDto['defaultValue'] {
    if (value == null || value === '') return undefined;
    if (type === 'string') return value;
    const text = value.trim();
    if (!text) return undefined;
    const messages: Record<string, string> = {
      boolean: 'Enter true or false.',
      number: 'Enter a finite number, e.g. 42 or 3.14.',
      integer: 'Enter a whole number, e.g. 42.',
      object: 'Enter a valid JSON object, e.g. {"city":"Berlin"}.',
      array: 'Enter a valid JSON array, e.g. ["one", "two"].',
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(messages[type]);
    }
    const valid =
      type === 'boolean'
        ? typeof parsed === 'boolean'
        : type === 'number'
          ? typeof parsed === 'number' && Number.isFinite(parsed)
          : type === 'integer'
            ? typeof parsed === 'number' && Number.isInteger(parsed)
            : type === 'object'
              ? parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              : type === 'array' && Array.isArray(parsed);
    if (!valid) throw new Error(messages[type]);
    return parsed as ClaimFieldDefinitionDto['defaultValue'];
  }

  get fields(): FormArray {
    return this.form.get('fields') as FormArray;
  }

  getFieldGroup(index: number): FormGroup {
    return this.fields.at(index) as FormGroup;
  }

  getFieldDisplayArray(fieldIndex: number): FormArray {
    return this.getFieldGroup(fieldIndex).get('display') as FormArray;
  }

  addField(): void {
    const field = this.createFieldGroup();
    this.fields.push(field);
    this.expandedFields.add(field);
  }

  removeField(index: number): void {
    this.fields.removeAt(index);
  }

  addFieldDisplay(fieldIndex: number): void {
    this.getFieldDisplayArray(fieldIndex).push(this.createFieldDisplayGroup());
  }

  removeFieldDisplay(fieldIndex: number, displayIndex: number): void {
    this.getFieldDisplayArray(fieldIndex).removeAt(displayIndex);
  }

  // IAE Actions Management
  iaeActionTypes = [
    { value: 'openid4vp_presentation', label: 'OID4VP Presentation', icon: 'verified_user' },
    { value: 'redirect_to_web', label: 'Redirect to Web', icon: 'open_in_browser' },
  ];

  createIaeActionGroup(
    action?: IaeActionOpenid4VpPresentation | IaeActionRedirectToWeb
  ): FormGroup {
    if (action?.type === 'redirect_to_web') {
      return new FormGroup({
        type: new FormControl('redirect_to_web', [Validators.required]),
        label: new FormControl(action.label || ''),
        url: new FormControl(action.url || '', [Validators.required]),
        callbackUrl: new FormControl(action.callbackUrl || ''),
        description: new FormControl(action.description || ''),
      });
    }
    // Default to openid4vp_presentation
    return new FormGroup({
      type: new FormControl('openid4vp_presentation', [Validators.required]),
      label: new FormControl((action as IaeActionOpenid4VpPresentation)?.label || ''),
      presentationConfigId: new FormControl(
        (action as IaeActionOpenid4VpPresentation)?.presentationConfigId || '',
        [Validators.required]
      ),
    });
  }

  get iaeActions(): FormArray {
    return this.form.get('iaeActions') as FormArray;
  }

  addIaeAction(
    type: 'openid4vp_presentation' | 'redirect_to_web' = 'openid4vp_presentation'
  ): void {
    const action =
      type === 'redirect_to_web'
        ? { type: 'redirect_to_web' as const, url: '', label: '' }
        : { type: 'openid4vp_presentation' as const, presentationConfigId: '', label: '' };
    this.iaeActions.push(this.createIaeActionGroup(action));
  }

  removeIaeAction(index: number): void {
    this.iaeActions.removeAt(index);
  }

  moveIaeAction(index: number, direction: 'up' | 'down'): void {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= this.iaeActions.length) return;

    const action = this.iaeActions.at(index);
    this.iaeActions.removeAt(index);
    this.iaeActions.insert(newIndex, action);
  }

  onIaeActionTypeChange(index: number, newType: string): void {
    const currentAction = this.iaeActions.at(index) as FormGroup;
    const currentLabel = currentAction.get('label')?.value || '';

    this.iaeActions.removeAt(index);
    const newAction =
      newType === 'redirect_to_web'
        ? { type: 'redirect_to_web' as const, url: '', label: currentLabel }
        : {
            type: 'openid4vp_presentation' as const,
            presentationConfigId: '',
            label: currentLabel,
          };
    this.iaeActions.insert(index, this.createIaeActionGroup(newAction));
  }

  dropIaeAction(event: CdkDragDrop<FormGroup[]>): void {
    moveItemInArray(this.iaeActions.controls, event.previousIndex, event.currentIndex);
    this.iaeActions.updateValueAndValidity();
  }

  /**
   * Open JSON view dialog to show/edit the complete configuration
   */
  viewAsJson(): void {
    const currentConfig = this.buildConfigurationPayload();

    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Complete Configuration JSON',
        jsonData: currentConfig,
        readonly: false,
        schema: credentialConfigSchema,
      },
      disableClose: true,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.loadConfigurationFromJson(result);
      }
    });
  }

  /**
   * Build configuration payload from form values with proper JSON parsing
   */
  private buildConfigurationPayload(): any {
    const formValue = { ...this.form.value };
    formValue.id = this.route.snapshot.params['id'] || formValue.id;

    const isMdoc = formValue.format === 'mso_mdoc';

    formValue.config = {
      format: formValue.format,
      display: formValue.displayConfigs,
      scope: formValue.scope || undefined,
      proofTypesSupported:
        formValue.proofTypesSupported?.length > 0
          ? formValue.proofTypesSupported
          : this.defaultProofTypesSupported,
      ...(formValue.credentialReusePolicyEnabled && {
        credentialReusePolicy: {
          id: 'arf_annex_ii',
          options: [
            {
              details: formValue.credentialReusePolicyDetails,
              ...(formValue.credentialReusePolicyDetails?.some((detail: string) =>
                ['once_only', 'rotating-batch', 'per-relying-party'].includes(detail)
              ) && { batch_size: Number(formValue.credentialReusePolicyBatchSize) }),
              ...(formValue.credentialReusePolicyDetails?.includes('once_only') && {
                reissue_trigger_unused: Number(formValue.credentialReusePolicyReissueTriggerUnused),
              }),
              ...(formValue.credentialReusePolicyDetails?.some((detail: string) =>
                ['limited_time', 'rotating-batch', 'per-relying-party'].includes(detail)
              ) && {
                reissue_trigger_lifetime_left: Number(
                  formValue.credentialReusePolicyReissueTriggerLifetimeLeft
                ),
              }),
            },
          ],
        },
      }),
      // Key attestation requirements (if enabled)
      ...(formValue.keyAttestationEnabled && {
        keyAttestationsRequired: {
          key_storage: formValue.keyStorageTypes?.length ? formValue.keyStorageTypes : undefined,
          user_authentication: formValue.userAuthenticationTypes?.length
            ? formValue.userAuthenticationTypes
            : undefined,
        },
      }),
      // mDOC specific fields
      ...(isMdoc && {
        docType: formValue.docType || undefined,
      }),
    };

    formValue.activeCredentials = {
      enabled: formValue.activeCredentialsEnabled,
      tracking: 'internal',
    };
    // The status management toggle is disabled (and thus missing from form.value) while
    // Single Active Credential is on, which requires it.
    formValue.statusManagement = !!(
      formValue.activeCredentialsEnabled || this.form.get('statusManagement')?.value
    );

    formValue.fields = this.buildFieldsPayload(formValue.fields || []);

    // Omit empty optional strings so they remain valid against the config schema.
    if (!formValue.keyChainId?.trim()) {
      delete formValue.keyChainId;
    }

    // SD-JWT specific fields (only include if SD-JWT format)
    if (isMdoc) {
      formValue.vct = null;
      formValue.sdJwtTrustFormat = null;
    } else {
      // Handle VCT based on mode:
      // - string mode: use custom URI entered by user
      // - object mode: send the metadata object (vct field inside will be auto-generated by backend)
      if (this.vctMode === 'string') {
        formValue.vct = formValue.vctString?.trim() || null;
      } else {
        formValue.vct = this.parseJsonField(formValue.vct, 'extract', true);
      }
      formValue.sdJwtTrustFormat = formValue.sdJwtTrustFormat || 'x5c';
    }

    formValue.embeddedDisclosurePolicy = this.parseJsonField(
      formValue.embeddedDisclosurePolicy,
      'extract',
      true
    );

    // Handle references - use null to clear
    formValue.attributeProviderId = formValue.attributeProviderId?.trim() || null;
    formValue.webhookEndpointId = formValue.webhookEndpointId?.trim() || null;

    // Handle iaeActions - use null to clear, or transform to proper format
    if (formValue.iaeActions?.length) {
      formValue.iaeActions = formValue.iaeActions.map((action: any) => {
        if (action.type === 'redirect_to_web') {
          return {
            type: action.type,
            label: action.label || undefined,
            url: action.url,
            callbackUrl: action.callbackUrl || undefined,
            description: action.description || undefined,
          };
        }
        return {
          type: action.type,
          label: action.label || undefined,
          presentationConfigId: action.presentationConfigId,
        };
      });
    } else {
      formValue.iaeActions = null;
    }

    // Clean up form-only fields
    delete formValue.displayConfigs;
    delete formValue.vctString;
    delete formValue.format;
    delete formValue.docType;
    delete formValue.scope;
    delete formValue.namespace;
    delete formValue.keyAttestationEnabled;
    delete formValue.keyStorageTypes;
    delete formValue.userAuthenticationTypes;
    delete formValue.proofTypesSupported;
    delete formValue.credentialReusePolicyEnabled;
    delete formValue.credentialReusePolicyDetails;
    delete formValue.credentialReusePolicyBatchSize;
    delete formValue.credentialReusePolicyReissueTriggerUnused;
    delete formValue.credentialReusePolicyReissueTriggerLifetimeLeft;
    delete formValue.activeCredentialsEnabled;

    return formValue;
  }

  /**
   * Helper to parse JSON fields with proper null/undefined handling
   * @param useNullForEmpty - if true, returns null for empty values (for PATCH to clear field)
   */
  private parseJsonField(
    value: any,
    mode: 'parse' | 'extract' = 'parse',
    useNullForEmpty = false
  ): any {
    if (!value || value === '') return useNullForEmpty ? null : undefined;
    if (typeof value !== 'string') return value;

    const parsed = JSON.parse(value);
    return mode === 'extract' ? extractSchema(value) : parsed;
  }

  private buildFieldsPayload(rawFields: any[]): ClaimFieldDefinitionDto[] {
    const flatFields = rawFields
      .map((rawField: any) => {
        const path = this.parseFieldPath(rawField['path']);
        const defaultValue = this.parseClaimDefault(rawField['defaultValue'], rawField['type']);
        const namespace = rawField['namespace']?.trim() || undefined;

        const field: ClaimFieldDefinitionDto = {
          path,
          type: rawField['type'],
          mandatory: !!rawField['mandatory'],
          disclosable: !!rawField['disclosable'],
          ...(namespace ? { namespace } : {}),
        };

        if (defaultValue !== undefined) {
          field.defaultValue = defaultValue;
        }

        const display = (rawField['display'] || [])
          .map((entry: any) => ({
            locale: entry['locale']?.trim() || entry['lang']?.trim(),
            name: entry['name']?.trim() || entry['label']?.trim(),
            description: entry['description']?.trim() || undefined,
          }))
          .filter((entry: FieldDisplayDto) => !!entry.locale && !!entry.name);

        if (display.length > 0) {
          field.display = display;
        }

        return field;
      })
      .filter((field) => field.path.length > 0);

    // Use one common nested field model for all formats.
    return this.buildNestedFieldDefinitions(flatFields);
  }

  private parseFieldPath(value: string): (string | number | null)[] {
    if (!value) {
      return [];
    }

    return value
      .split('.')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        if (segment === '*') {
          return null;
        }

        if (/^\d+$/.test(segment)) {
          return Number(segment);
        }

        return segment;
      });
  }

  private getFieldNamespaceForForm(field: ClaimFieldDefinitionDto | undefined): string {
    const explicitNamespace = field?.namespace?.trim();
    if (explicitNamespace) {
      return explicitNamespace;
    }

    return '';
  }

  private normalizeFieldPathForForm(field: ClaimFieldDefinitionDto | undefined): string {
    const path = field?.path || [];
    if (path.length === 0) {
      return '';
    }

    return path
      .map((segment) => {
        if (segment === null) {
          return '*';
        }

        return String(segment);
      })
      .join('.');
  }

  private resolveChildPathForForm(
    parentPath: (string | number | null)[],
    parentType: ClaimFieldDefinitionDto['type'],
    childPath: (string | number | null)[]
  ): (string | number | null)[] {
    if (childPath.length >= parentPath.length) {
      const startsWithParent = parentPath.every((seg, i) => seg === childPath[i]);
      if (startsWithParent) {
        return childPath;
      }
    }

    if (parentType === 'array') {
      if (childPath.length === 0) {
        return [...parentPath, null];
      }
      if (childPath[0] === null || typeof childPath[0] === 'number') {
        return [...parentPath, childPath[0], ...childPath.slice(1)];
      }
      return [...parentPath, null, ...childPath];
    }

    return [...parentPath, ...childPath];
  }

  private flattenFieldDefinitionsForForm(
    fields: ClaimFieldDefinitionDto[]
  ): ClaimFieldDefinitionDto[] {
    const result: ClaimFieldDefinitionDto[] = [];

    const visit = (field: ClaimFieldDefinitionDto): void => {
      const { children, ...fieldWithoutChildren } = field as ClaimFieldDefinitionDto & {
        children?: ClaimFieldDefinitionDto[];
      };

      result.push(fieldWithoutChildren);

      if (children?.length) {
        const resolvedChildren = children.map((child) => ({
          ...child,
          path: this.resolveChildPathForForm(field.path, field.type, child.path),
          namespace: child.namespace ?? field.namespace,
        }));

        resolvedChildren.forEach((child) => visit(child));
      }
    };

    fields.forEach((field) => visit(field));
    return result;
  }

  private buildNestedFieldDefinitions(
    flatFields: ClaimFieldDefinitionDto[]
  ): ClaimFieldDefinitionDto[] {
    type MutableField = ClaimFieldDefinitionDto & { children?: MutableField[] };
    interface IndexedNode {
      absolutePath: (string | number | null)[];
      node: MutableField;
      namespace: string;
    }

    const byNamespace = new Map<string, MutableField[]>();

    for (const field of flatFields) {
      const key = field.namespace || '__global__';
      const list = byNamespace.get(key) ?? [];
      list.push({ ...field });
      byNamespace.set(key, list);
    }

    const nested: MutableField[] = [];

    for (const [, list] of byNamespace.entries()) {
      list.sort((a, b) => a.path.length - b.path.length);

      const roots: MutableField[] = [];
      const inserted: IndexedNode[] = [];

      for (const field of list) {
        let parent: IndexedNode | undefined;

        const absolutePath = [...field.path];
        const namespace = field.namespace || '__global__';

        for (const candidate of inserted) {
          if (candidate.namespace !== namespace) {
            continue;
          }

          if (candidate.absolutePath.length >= absolutePath.length) {
            continue;
          }

          if (candidate.node.type !== 'object' && candidate.node.type !== 'array') {
            continue;
          }

          const matchesPrefix = candidate.absolutePath.every(
            (seg, idx) => seg === absolutePath[idx]
          );
          if (!matchesPrefix) {
            continue;
          }

          if (!parent || candidate.absolutePath.length > parent.absolutePath.length) {
            parent = candidate;
          }
        }

        if (!parent) {
          roots.push(field);
          inserted.push({ absolutePath, node: field, namespace });
          continue;
        }

        const relativePath = absolutePath.slice(parent.absolutePath.length);

        const child: MutableField = {
          ...field,
          path: relativePath,
        };

        parent.node.children ??= [];
        parent.node.children.push(child);
        inserted.push({ absolutePath, node: child, namespace });
      }

      nested.push(...roots);
    }

    return nested;
  }

  /**
   * Helper to stringify values for form fields
   */
  private stringifyField(value: any): string {
    return value ? JSON.stringify(value, null, 2) : '';
  }

  /**
   * Load configuration from JSON object into the form
   */
  private loadConfigurationFromJson(config: CredentialConfigCreate): void {
    try {
      this.patchFormFromConfig(config);

      this.snackBar.open('Configuration loaded from JSON successfully', 'OK', {
        duration: 3000,
      });
    } catch (error) {
      console.error('Error loading configuration from JSON:', error);
      this.snackBar.open('Error loading configuration from JSON', 'Close', {
        duration: 3000,
      });
    }
  }

  /**
   * Load a predefined configuration
   */
  loadPredefinedConfig(configTemplate: any): void {
    const config = structuredClone(configTemplate.config);

    this.loadConfigurationFromJson(config);

    this.snackBar.open(`${configTemplate.name} template loaded successfully`, 'OK', {
      duration: 3000,
    });
  }

  /**
   * Show predefined configuration in JSON view (readonly)
   */
  previewPredefinedConfig(configTemplate: any): void {
    this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: `${configTemplate.name} - Preview`,
        jsonData: configTemplate.config,
      },
      disableClose: false,
      maxWidth: '95vw',
      maxHeight: '95vh',
    });
  }
}
