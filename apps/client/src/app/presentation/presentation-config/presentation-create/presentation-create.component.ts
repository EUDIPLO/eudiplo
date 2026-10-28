import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  presentationManagementControllerUpdateConfiguration,
  presentationManagementControllerReissueRegistrationCertificate,
  keyChainControllerGetAll,
  defaultAccessKeyChainControllerGet,
  type DefaultAccessKeyChainDto,
  webhookEndpointControllerGetAll,
  KeyChainResponseDto,
  WebhookEndpointEntity,
} from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../presentation-management.service';
import { MatDialog } from '@angular/material/dialog';
import { JsonViewDialogComponent } from '../../../issuance/credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { IssuerMetadataBrowserComponent } from '../issuer-metadata-browser/issuer-metadata-browser.component';
import { SchemaBrowserComponent } from '../schema-browser/schema-browser.component';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { configs } from './pre-config';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { EditorComponent, extractSchema } from '../../../utils/editor/editor.component';
import {
  DCQLSchema,
  presentationConfigSchema,
  transactionDataArraySchema,
} from '../../../utils/schemas';
import {
  formatRegistrationCertExpiresIn,
  getRegistrationCertStatus,
} from '../../../utils/registration-cert-status';
import { CredentialIdsComponent } from '../../credential-ids/credential-ids.component';
import { RegistrarService } from '../../../registrar/registrar.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { DcqlQueryEditorComponent } from '../dcql-query-editor/dcql-query-editor.component';
import {
  dcqlReferenceError,
  parseDcql,
  readSimpleDcql,
  trustSummary,
} from '../dcql-query-editor/simple-dcql';
import { schemaFormValidator } from '../../../utils/schema-form-validator';
import { getApiErrorMessage } from '../../../utils/error-message';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { LoadErrorComponent } from '../../../common/load-error.component';

@Component({
  selector: 'app-presentation-create',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
    MatMenuModule,
    MatDividerModule,
    MatTabsModule,
    MatExpansionModule,
    MatTooltipModule,
    DcqlQueryEditorComponent,
    MonacoEditorModule,
    EditorComponent,
    CredentialIdsComponent,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './presentation-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./presentation-create.component.scss'],
})
export class PresentationCreateComponent implements OnInit {
  readonly statusCheckModeOptions: {
    value: 'strict' | 'best_effort' | 'disabled';
    label: string;
    hint: string;
  }[] = [
    {
      value: 'strict',
      label: 'Strict',
      hint: 'Always check status list; fail verification when unavailable.',
    },
    {
      value: 'best_effort',
      label: 'Best effort',
      hint: 'Try status list check, continue when temporarily unavailable.',
    },
    {
      value: 'disabled',
      label: 'Disabled',
      hint: 'Do not perform status list checks.',
    },
  ];

  public form: FormGroup;
  public create = true;
  public copyMode = false;
  public registrationCertTabIndex = 0;
  public registrationCertCache: any = null;
  public reissuing = false;
  public guided = true;
  public activeStep = 0;
  public furthestStep = 0;
  public showSettingsErrors = false;
  public validationMessage = '';
  public saving = false;
  /** While the configuration to edit or copy loads; saving before would overwrite it. */
  loadingConfig = false;
  /** Set when the configuration to edit or copy could not be loaded; the form stays hidden. */
  loadError = '';
  public keyChainsLoaded = false;
  /** The tenant's default access key chain; undefined while unknown, then all chains count. */
  private defaultAccess?: DefaultAccessKeyChainDto;
  readonly stepDescriptions = [
    'Name your reusable request',
    'Choose credentials and claims',
    'Review defaults and optional settings',
    'Check the configuration before saving',
  ];

  transactionDataArraySchema = transactionDataArraySchema;

  public predefinedConfigs = configs;

  public keyChains: KeyChainResponseDto[] = [];
  public webhookEndpoints: WebhookEndpointEntity[] = [];

  readonly purposeLanguageOptions = [
    { value: 'en-US', label: 'English (US)' },
    { value: 'en-GB', label: 'English (UK)' },
    { value: 'de-DE', label: 'German' },
    { value: 'fr-FR', label: 'French' },
    { value: 'it-IT', label: 'Italian' },
    { value: 'es-ES', label: 'Spanish' },
    { value: 'nl-NL', label: 'Dutch' },
    { value: 'pt-PT', label: 'Portuguese' },
    { value: 'pl-PL', label: 'Polish' },
    { value: 'cs-CZ', label: 'Czech' },
    { value: 'sk-SK', label: 'Slovak' },
    { value: 'sl-SI', label: 'Slovenian' },
    { value: 'hr-HR', label: 'Croatian' },
    { value: 'hu-HU', label: 'Hungarian' },
    { value: 'ro-RO', label: 'Romanian' },
    { value: 'bg-BG', label: 'Bulgarian' },
    { value: 'el-GR', label: 'Greek' },
    { value: 'fi-FI', label: 'Finnish' },
    { value: 'sv-SE', label: 'Swedish' },
    { value: 'da-DK', label: 'Danish' },
    { value: 'et-EE', label: 'Estonian' },
    { value: 'lv-LV', label: 'Latvian' },
    { value: 'lt-LT', label: 'Lithuanian' },
    { value: 'mt-MT', label: 'Maltese' },
    { value: 'ga-IE', label: 'Irish' },
  ];

  constructor(
    private readonly presentationService: PresentationManagementService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog,
    private readonly registrarService: RegistrarService
  ) {
    this.form = new FormGroup({
      id: new FormControl(undefined, [Validators.required]),
      description: new FormControl(undefined, [Validators.required]),
      redirectUri: new FormControl(undefined),
      accessKeyChainId: new FormControl(undefined),
      dcql_query: new FormControl(undefined, [
        Validators.required,
        schemaFormValidator(DCQLSchema),
        (control) => {
          const error = dcqlReferenceError(control.value);
          return error ? { invalidReference: error } : null;
        },
      ]),
      lifeTime: new FormControl(300, [Validators.required, Validators.min(1)]),
      statusCheckMode: new FormControl<'strict' | 'best_effort' | 'disabled'>('strict'),
      registrationCertImportJwt: new FormControl(undefined),
      registrationCertImportId: new FormControl(undefined),
      registrationCertBodyPrivacyPolicy: new FormControl(undefined),
      registrationCertBodySupportUri: new FormControl(undefined),
      registrationCertBodyIntermediary: new FormControl(undefined),
      registrationCertBodyPurpose: new FormArray([]),
      transaction_data: new FormControl(undefined, [
        schemaFormValidator(transactionDataArraySchema),
      ]),
      attached: new FormArray([]),
      webhookEndpointId: new FormControl(''), // Predefined webhook endpoint selector
    });
  }

  ngOnInit(): void {
    this.guided = !this.route.snapshot.params['id'];
    this.loadRegistrarDefaults();

    // Load key chains for the select dropdown (filter by access usage type)
    keyChainControllerGetAll({}).then(
      (res) => {
        this.keyChains = (res.data || []).filter((keyChain) => keyChain.usageType === 'access');
        this.keyChainsLoaded = true;
      },
      (error) => {
        console.error('Failed to load key chains:', error);
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to load key chains'));
      }
    );
    // Without it the access hint checks every access key chain.
    defaultAccessKeyChainControllerGet().then(
      ({ data }) => (this.defaultAccess = data),
      () => undefined
    );

    // Load webhook endpoints for the select dropdown
    webhookEndpointControllerGetAll({}).then(
      (res) => (this.webhookEndpoints = (res.data || []) as WebhookEndpointEntity[]),
      (error) => {
        console.error('Failed to load webhook endpoints:', error);
        openErrorSnackBar(
          this.snackBar,
          getApiErrorMessage(error, 'Failed to load webhook endpoints')
        );
      }
    );

    if (this.route.snapshot.params['id']) {
      // Check if this is a copy operation
      this.copyMode = this.route.snapshot.url.some((segment) => segment.path === 'copy');
      // An edit page stays one while it loads, also when the load fails.
      this.create = this.copyMode;
      this.loadConfigForEdit();
    }
  }

  /** Loads the configuration to edit or copy; on failure the form stays hidden behind a retry. */
  loadConfigForEdit(): void {
    this.loadingConfig = true;
    this.loadError = '';
    this.presentationService
      .getPresentationById(this.route.snapshot.params['id'])
      .then(
        (config) => {
          if (!config) {
            this.snackBar.open('Presentation not found', 'Close', {
              duration: 3000,
            });
            this.router.navigate(['../'], { relativeTo: this.route });
            return;
          }

          // Convert dcql_query object to JSON string for form display
          const formData: any = { ...config };
          if (!formData.statusCheckMode) {
            formData.statusCheckMode = 'strict';
          }
          if (formData.dcql_query && typeof formData.dcql_query === 'object') {
            formData.dcql_query = JSON.stringify(formData.dcql_query, null, 2);
          }

          if (formData.registration_cert && typeof formData.registration_cert === 'object') {
            this.loadRegistrationCertIntoForm(formData.registration_cert);
            delete formData.registration_cert;
          }

          this.registrationCertCache = formData.registrationCertCache ?? null;
          delete formData.registrationCertCache;

          if (formData.transaction_data && typeof formData.transaction_data === 'object') {
            formData.transaction_data = JSON.stringify(formData.transaction_data, null, 2);
          }

          (formData.attached || []).forEach(() => this.addAttachment());

          // Remove inline webhook config since we only support webhook endpoint references
          delete formData.webhook;

          if (this.copyMode) {
            // Copy mode: clear ID and keep it editable, set create mode
            formData.id = `${config.id}-copy`;
            this.form.patchValue(formData);
            this.create = true;
          } else {
            // Edit mode: disable ID field
            this.form.patchValue(formData);
            this.form.get('id')?.disable();
            this.create = false;
          }
        },
        (error) => {
          console.error('Error loading presentation configuration:', error);
          this.loadError = getApiErrorMessage(error, 'Failed to load presentation configuration');
        }
      )
      .finally(() => (this.loadingConfig = false));
  }

  get queryControl(): FormControl {
    return this.form.get('dcql_query') as FormControl;
  }

  toggleGuided(): void {
    this.guided = !this.guided;
    this.furthestStep = Math.max(this.furthestStep, this.activeStep);
  }

  private stepFields(step: number): string[] {
    if (step === 0) return ['id', 'description'];
    if (step === 1) return ['dcql_query'];
    return Object.keys(this.form.controls).filter(
      (key) => !['id', 'description', 'dcql_query'].includes(key)
    );
  }

  private validateStep(step: number): boolean {
    const controls = this.stepFields(step).map((key) => this.form.controls[key]);
    controls.forEach((control) => control.markAllAsTouched());
    if (step === 2 && this.integrationReferenceError) {
      this.validationMessage = this.integrationReferenceError;
      this.showSettingsErrors = true;
      return false;
    }
    if (controls.some((control) => control.invalid)) {
      this.validationMessage = `Check the highlighted fields in ${['Name', 'Credentials', 'Settings'][step]}.`;
      if (step === 2) this.showSettingsErrors = true;
      return false;
    }
    this.validationMessage = '';
    return true;
  }

  nextStep(): void {
    if (this.activeStep >= 3 || !this.validateStep(this.activeStep)) return;
    this.furthestStep = Math.max(this.furthestStep, this.activeStep + 1);
    this.activeStep++;
  }

  submitPresentation(): void {
    if (this.loadingConfig || this.loadError) return;
    if (this.guided && this.activeStep < 3) {
      this.nextStep();
      return;
    }
    this.createOrUpdatePresentation();
  }

  get hasRequestOverrides(): boolean {
    const value = this.form.getRawValue();
    return (
      value.lifeTime !== 300 ||
      value.statusCheckMode !== 'strict' ||
      !!value.accessKeyChainId ||
      !!value.redirectUri
    );
  }

  get hasRegistrationCertificate(): boolean {
    return !!this.buildRegistrationCertFromForm();
  }

  get hasIntegrationOptions(): boolean {
    return !!this.form.get('webhookEndpointId')?.value || this.getFormArray('attached').length > 0;
  }

  get accessSetupMessage(): string | null {
    if (!this.keyChainsLoaded) return null;
    const selected = this.form.get('accessKeyChainId')?.value;
    // Without its own access key chain, a request uses the tenant's default when one is set.
    if (!selected && this.defaultAccess?.defaultAccessKeyChainId) {
      const chain = this.keyChains.find(
        (keyChain) => keyChain.id === this.defaultAccess?.keyChainId
      );
      if (!chain) {
        return 'The default access key chain of the tenant does not exist. Choose another one under Key Management, or select an access key chain here.';
      }
      return chain.activeCertificate?.pem
        ? null
        : 'The default access key chain has no active access certificate. Create or refresh it under Key Management, or select another access key chain here.';
    }
    const chains = selected
      ? this.keyChains.filter((chain) => chain.id === selected)
      : this.keyChains;
    return chains.some((chain) => chain.activeCertificate?.pem)
      ? null
      : 'An access key chain with an active certificate is needed to create presentation requests.';
  }

  get hasAdvancedQuery(): boolean {
    return readSimpleDcql(this.queryControl.value) === null;
  }

  get querySummary(): {
    id: string;
    format: string;
    type: string;
    claims: string[];
    trust: string;
  }[] {
    const query = parseDcql(this.queryControl.value) as any;
    if (!Array.isArray(query?.credentials)) return [];
    return query.credentials
      .filter((credential: any) => credential && typeof credential === 'object')
      .map((credential: any) => ({
        id: credential.id,
        format: credential.format,
        trust:
          Array.isArray(credential.trusted_authorities) &&
          credential.trusted_authorities.every(
            (authority: any) =>
              ['etsi_tl', 'openid_federation'].includes(authority?.type) &&
              Array.isArray(authority?.values) &&
              authority.values.every((value: any) =>
                authority.type === 'openid_federation'
                  ? typeof value === 'string'
                  : value && typeof value === 'object'
              )
          )
            ? trustSummary(credential.trusted_authorities)
            : credential.trusted_authorities
              ? 'Review issuer trust in DCQL JSON'
              : 'No issuer trust constraint configured',
        type: Array.isArray(credential.meta?.vct_values)
          ? credential.meta.vct_values.join(', ')
          : typeof credential.meta?.doctype_value === 'string'
            ? credential.meta.doctype_value
            : '',
        claims: Array.isArray(credential.claims)
          ? !credential.claims.length
            ? ['Empty claims list: remove "claims" to request no claims']
            : credential.claims.map((claim: any) =>
                Array.isArray(claim?.path)
                  ? claim.path
                      .map((part: unknown) =>
                        typeof part === 'number' ? `[${part}]` : String(part)
                      )
                      .join(' › ') +
                    (Array.isArray(claim.values)
                      ? ` — allowed values: ${claim.values.map((value: unknown) => JSON.stringify(value)).join(', ')}`
                      : '') +
                    (typeof claim.intent_to_retain === 'boolean'
                      ? ` — retain: ${claim.intent_to_retain ? 'yes' : 'no'}`
                      : '')
                  : 'Invalid claim path'
              )
          : credential.claims === undefined
            ? []
            : ['Invalid claims list'],
      }));
  }

  get credentialRequirements(): { required: boolean; options: string[] }[] | null {
    const query = parseDcql(this.queryControl.value) as any;
    if (!Array.isArray(query?.credential_sets)) return null;
    return query.credential_sets.map((set: any) => ({
      required: set?.required !== false,
      options: Array.isArray(set?.options)
        ? set.options.map((option: any) =>
            Array.isArray(option) ? option.join(' + ') : 'Invalid alternative'
          )
        : [],
    }));
  }

  /** Renamed/deleted query IDs must also be repaired in integration settings before saving. */
  get integrationReferenceError(): string | null {
    const query = parseDcql(this.queryControl.value) as any;
    const ids = new Set(
      Array.isArray(query?.credentials) ? query.credentials.map((entry: any) => entry?.id) : []
    );
    const transactions = parseDcql(this.form.get('transaction_data')?.value);
    const entries = [
      ...this.getFormArray('attached')
        .getRawValue()
        .map((entry: any) => ({ entry, section: 'Attachments' })),
      ...(Array.isArray(transactions)
        ? transactions.map((entry) => ({ entry, section: 'Transaction data' }))
        : []),
    ];
    for (const { entry, section } of entries) {
      if (!Array.isArray(entry?.credential_ids)) continue;
      const missing = entry.credential_ids.find((id: unknown) => !ids.has(id));
      if (missing !== undefined)
        return `${section} references missing credential "${missing}". Update its credential IDs in Settings.`;
    }
    return null;
  }

  private async loadRegistrarDefaults(): Promise<void> {
    try {
      const config = await this.registrarService.getConfig();
      const defaults = config?.registrationCertificateDefaults;
      if (!defaults || typeof defaults !== 'object') {
        return;
      }

      this.applyRegistrationCertDefaultsIfMissing(defaults as Record<string, unknown>);
    } catch {
      // Optional enhancement only; keep form functional if registrar config is unavailable.
    }
  }

  private applyRegistrationCertDefaultsIfMissing(defaults: Record<string, unknown>): void {
    const privacy =
      typeof defaults['privacy_policy'] === 'string' ? defaults['privacy_policy'].trim() : '';
    const support =
      typeof defaults['support_uri'] === 'string' ? defaults['support_uri'].trim() : '';
    const intermediary =
      typeof defaults['intermediary'] === 'string' ? defaults['intermediary'].trim() : '';

    const privacyCtrl = this.form.get('registrationCertBodyPrivacyPolicy');
    const supportCtrl = this.form.get('registrationCertBodySupportUri');
    const intermediaryCtrl = this.form.get('registrationCertBodyIntermediary');

    const currentPrivacy = `${privacyCtrl?.value ?? ''}`.trim();
    const currentSupport = `${supportCtrl?.value ?? ''}`.trim();
    const currentIntermediary = `${intermediaryCtrl?.value ?? ''}`.trim();

    if (!currentPrivacy && privacy) {
      privacyCtrl?.setValue(privacy);
    }
    if (!currentSupport && support) {
      supportCtrl?.setValue(support);
    }
    if (!currentIntermediary && intermediary) {
      intermediaryCtrl?.setValue(intermediary);
    }
  }

  getFormArray(value: string) {
    return this.form.get(value) as FormArray;
  }

  addAttachment(): void {
    this.getFormArray('attached').push(
      new FormGroup({
        format: new FormControl(undefined, [Validators.required]),
        data: new FormControl(undefined, [Validators.required]),
        credential_ids: new FormControl(),
      })
    );
  }

  removeAttachment(index: number) {
    (this.form.get('attached') as FormArray).removeAt(index);
  }

  getFormGroup(value: string) {
    return this.form.get(value) as FormGroup;
  }

  get selectedStatusCheckModeLabel(): string {
    const selected = this.form.get('statusCheckMode')?.value;
    return this.statusCheckModeOptions.find((mode) => mode.value === selected)?.label ?? 'Strict';
  }

  asFormGroup(value: any) {
    return value as FormGroup;
  }

  createOrUpdatePresentation(): void {
    if (this.saving) return;
    for (let step = 0; step < 3; step++) {
      if (!this.validateStep(step)) {
        this.furthestStep = Math.max(this.furthestStep, step);
        this.activeStep = step;
        return;
      }
    }
    const formValue = this.getCompleteConfiguration(false);

    // Clean up webhookEndpointId - use null to clear (PATCH semantics)
    formValue.webhookEndpointId = formValue.webhookEndpointId?.trim() || null;

    if (!formValue.registration_cert) {
      formValue.registration_cert = null; // Set to null to clear registration_cert
    }

    if (!formValue.transaction_data) {
      formValue.transaction_data = null; // Set to null to clear transaction_data
    }

    // In copy mode or new creation, use form ID; in edit mode, use route param ID
    if (!this.copyMode && this.route.snapshot.params['id']) {
      formValue.id = this.route.snapshot.params['id'];
    }

    this.saving = true;
    if (this.create) {
      this.presentationService
        .createConfiguration(formValue)
        .then(
          (res: any) => {
            // In copy mode, navigate up two levels (past :id/copy), otherwise one level
            const navigatePath = this.copyMode ? ['../../', res.id] : ['../', res.id];
            this.router.navigate(navigatePath, { relativeTo: this.route });
            this.snackBar.open('Presentation created successfully', 'Close', {
              duration: 3000,
            });
          },
          (err: unknown) =>
            openErrorSnackBar(
              this.snackBar,
              getApiErrorMessage(err, 'Failed to create presentation', { allIssues: true })
            )
        )
        .finally(() => (this.saving = false));
    } else {
      presentationManagementControllerUpdateConfiguration({
        body: formValue,
        path: { id: formValue.id },
      })
        .then(
          () => {
            this.router.navigate(['../'], { relativeTo: this.route });
            this.snackBar.open('Presentation updated successfully', 'Close', {
              duration: 3000,
            });
          },
          (err: unknown) => {
            openErrorSnackBar(
              this.snackBar,
              getApiErrorMessage(err, 'Failed to update presentation', { allIssues: true })
            );
          }
        )
        .finally(() => (this.saving = false));
    }
  }

  // Helper method to format JSON for display
  formatJson(): void {
    const dcqlControl = this.form.get('dcql_query');
    if (dcqlControl?.value) {
      try {
        const parsed = JSON.parse(dcqlControl.value);
        const formatted = JSON.stringify(parsed, null, 2);
        dcqlControl.setValue(formatted);
      } catch {
        // Invalid JSON, don't format
      }
    }
  }

  /**
   * Show/Edit the entire presentation config as JSON
   */
  viewAsJson(): void {
    const currentConfig = this.getCompleteConfiguration();
    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Presentation Configuration JSON',
        jsonData: currentConfig,
        readonly: false,
        schema: presentationConfigSchema,
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
   * Get the complete config object from form values
   */
  private getCompleteConfiguration(forExport = true): any {
    const formValue = { ...this.form.getRawValue() };

    this.ensureValidStatusCheckMode(formValue);

    delete formValue.registrationCertImportJwt;
    delete formValue.registrationCertImportId;
    delete formValue.registrationCertBodyPrivacyPolicy;
    delete formValue.registrationCertBodySupportUri;
    delete formValue.registrationCertBodyIntermediary;
    delete formValue.registrationCertBodyPurpose;

    // Parse dcql_query if it's a string
    if (formValue.dcql_query && typeof formValue.dcql_query === 'string') {
      try {
        formValue.dcql_query = extractSchema(formValue.dcql_query);
      } catch {
        // Ignore JSON parse errors
      }
    }

    if (formValue.transaction_data && typeof formValue.transaction_data === 'string') {
      try {
        formValue.transaction_data = extractSchema(formValue.transaction_data);
      } catch {
        // Ignore JSON parse errors
      }
    }

    formValue.registration_cert = forExport
      ? this.getExportRegistrationCert()
      : this.buildRegistrationCertFromForm();
    if (!formValue.webhook?.url) {
      formValue.webhook = undefined;
    }
    if (!formValue.registration_cert) {
      formValue.registration_cert = undefined; // Remove registrationCert if not provided
    }

    if (forExport && !formValue.redirectUri) {
      formValue.redirectUri = undefined;
    }

    if (forExport && !formValue.accessKeyChainId) {
      formValue.accessKeyChainId = undefined;
    }

    if (
      formValue.transaction_data == null ||
      (Array.isArray(formValue.transaction_data) && formValue.transaction_data.length === 0) ||
      formValue.transaction_data === ''
    ) {
      formValue.transaction_data = undefined;
    }

    // Clean up empty optional fields
    if (forExport && formValue.attached?.length === 0) {
      formValue.attached = undefined;
    }
    return formValue;
  }

  private ensureValidStatusCheckMode(formValue: any): void {
    if (
      formValue.statusCheckMode !== 'strict' &&
      formValue.statusCheckMode !== 'best_effort' &&
      formValue.statusCheckMode !== 'disabled'
    ) {
      formValue.statusCheckMode = 'strict';
    }
  }

  private getExportRegistrationCert(): any {
    const body = this.getRegistrationCertBodyFromForm();
    const importId = `${this.form.get('registrationCertImportId')?.value ?? ''}`.trim();
    const cachedJwt = this.registrationCertCache?.jwt;
    if (typeof cachedJwt === 'string' && cachedJwt.trim().length > 0) {
      return {
        ...(body ? { body } : {}),
        ...(importId ? { id: importId } : {}),
        jwt: cachedJwt.trim(),
      };
    }

    return this.buildRegistrationCertFromForm();
  }

  private getRegistrationCertBodyFromForm(): any {
    const purpose = this.registrationCertPurposeArray.controls
      .map((ctrl) => ({
        lang: ctrl.get('lang')?.value?.trim(),
        content: ctrl.get('content')?.value?.trim(),
      }))
      .filter((entry) => entry.lang && entry.content);

    if (purpose.length === 0) {
      return null;
    }

    const privacyPolicy = this.form.get('registrationCertBodyPrivacyPolicy')?.value?.trim();
    const supportUri = this.form.get('registrationCertBodySupportUri')?.value?.trim();
    const intermediary = this.form.get('registrationCertBodyIntermediary')?.value?.trim();

    const body: any = { purpose };
    if (privacyPolicy) {
      body.privacy_policy = privacyPolicy;
    }
    if (supportUri) {
      body.support_uri = supportUri;
    }
    if (intermediary) {
      body.intermediary = intermediary;
    }

    return body;
  }

  /**
   * Load a predefined configuration
   */
  loadPredefinedConfig(configTemplate: any): void {
    const config = structuredClone(configTemplate.config); // Deep clone
    // Choosing a starting point in step two must not replace the name from step one.
    config.id = this.form.get('id')?.value || config.id;
    config.description = this.form.get('description')?.value || config.description;

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
        readonly: true,
      },
      disableClose: false,
      maxWidth: '95vw',
      maxHeight: '95vh',
    });
  }

  /**
   * Import config from JSON and update the form
   */
  private loadConfigurationFromJson(config: any): void {
    try {
      const formData: any = { ...config };
      if (formData.dcql_query) {
        formData.dcql_query = extractSchema(formData.dcql_query);
      }
      const registrationCert = formData.registration_cert
        ? extractSchema(formData.registration_cert)
        : null;
      delete formData.registration_cert;
      const existingId = this.form.get('id')?.value;
      this.getFormArray('attached').clear();
      this.registrationCertPurposeArray.clear();
      this.form.reset({ lifeTime: 300, statusCheckMode: 'strict', webhookEndpointId: '' });
      this.registrationCertTabIndex = 0;
      this.loadRegistrationCertIntoForm(registrationCert);
      (formData.attached || []).forEach(() => this.addAttachment());
      this.form.patchValue(formData);
      if (!this.create) this.form.get('id')?.setValue(existingId);
      this.form.markAsDirty();
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
   * Copy text to clipboard
   */
  async copyToClipboard(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.snackBar.open(`${label} copied to clipboard!`, 'OK', {
        duration: 2000,
        panelClass: ['success-snackbar'],
      });
    } catch (err) {
      console.error('Failed to copy text: ', err);
      this.snackBar.open(`Failed to copy ${label}`, 'OK', {
        duration: 3000,
        panelClass: ['error-snackbar'],
      });
    }
  }

  /**
   * Open the issuer metadata browser dialog to import DCQL from an issuer
   */
  importFromIssuer(): void {
    const dialogRef = this.dialog.open(IssuerMetadataBrowserComponent, {
      data: {},
      disableClose: false,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe((dcqlQuery) => {
      if (dcqlQuery) {
        // Set the DCQL query in the form
        this.form.get('dcql_query')?.setValue(JSON.stringify(dcqlQuery, null, 2));
        this.snackBar.open('DCQL query imported from issuer', 'OK', {
          duration: 3000,
        });
      }
    });
  }

  /**
   * Open the schema metadata browser dialog to import DCQL from schema metadata.
   */
  importFromSchemaMetadata(): void {
    const dialogRef = this.dialog.open(SchemaBrowserComponent, {
      data: {},
      disableClose: false,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        const dcqlQuery = result.dcqlQuery ? result.dcqlQuery : result;
        this.form.get('dcql_query')?.setValue(JSON.stringify(dcqlQuery, null, 2));

        const idControl = this.form.get('id');
        const descriptionControl = this.form.get('description');

        const currentId = `${idControl?.value ?? ''}`.trim();
        const currentDescription = `${descriptionControl?.value ?? ''}`.trim();

        if (!currentId && typeof result.suggestedPresentationId === 'string') {
          idControl?.setValue(result.suggestedPresentationId);
        }

        if (!currentDescription && typeof result.suggestedDescription === 'string') {
          descriptionControl?.setValue(result.suggestedDescription);
        }

        this.snackBar.open('DCQL query imported from schema', 'OK', {
          duration: 3000,
        });
      }
    });
  }

  get registrationCertPurposeArray(): FormArray {
    return this.form.get('registrationCertBodyPurpose') as FormArray;
  }

  addRegistrationCertPurpose(lang = 'en-US', value = ''): void {
    const normalizedLang = this.purposeLanguageOptions.some((option) => option.value === lang)
      ? lang
      : 'en-US';

    this.registrationCertPurposeArray.push(
      new FormGroup({
        lang: new FormControl(normalizedLang, [Validators.required]),
        content: new FormControl(value, [Validators.required]),
      })
    );
  }

  removeRegistrationCertPurpose(index: number): void {
    this.registrationCertPurposeArray.removeAt(index);
  }

  /**
   * Status of the persisted registration-certificate cache for the loaded
   * presentation config. The backend invalidates this cache automatically
   * when the registrationCert spec or dcql_query change, so a `null` cache
   * after editing those fields means a fresh issuance is pending.
   */
  get registrationCertStatus(): 'none' | 'active' | 'expiring' | 'expired' | 'pending' {
    if (this.create) return 'none';
    return getRegistrationCertStatus({
      registration_cert: this.buildRegistrationCertFromForm() as any,
      registrationCertCache: this.registrationCertCache,
    });
  }

  get registrationCertExpiresIn(): string | null {
    return formatRegistrationCertExpiresIn(this.registrationCertCache);
  }

  reissueRegistrationCert(): void {
    const id = this.route.snapshot.params['id'];
    if (!id || this.create) return;
    this.reissuing = true;
    presentationManagementControllerReissueRegistrationCertificate({
      path: { id },
    })
      .then((res: any) => {
        this.registrationCertCache = res?.data?.registrationCertCache ?? null;
        this.snackBar.open('Registration certificate reissued', 'Close', {
          duration: 3000,
        });
      })
      .catch((err) => {
        console.error('Failed to reissue registration certificate', err);
        openErrorSnackBar(
          this.snackBar,
          getApiErrorMessage(err, 'Failed to reissue registration certificate')
        );
      })
      .finally(() => {
        this.reissuing = false;
      });
  }

  private buildRegistrationCertFromForm(): any {
    if (this.registrationCertTabIndex === 0) {
      const jwt = this.form.get('registrationCertImportJwt')?.value?.trim();
      const id = this.form.get('registrationCertImportId')?.value?.trim();

      if (jwt) {
        return { jwt };
      }

      if (id) {
        return { id };
      }

      return null;
    }

    const body = this.getRegistrationCertBodyFromForm();
    if (!body) {
      return null;
    }

    return { body };
  }

  private loadRegistrationCertIntoForm(registrationCert: any): void {
    this.form.patchValue({
      registrationCertImportJwt: registrationCert?.jwt ?? undefined,
      registrationCertImportId: registrationCert?.id ?? undefined,
      registrationCertBodyPrivacyPolicy: registrationCert?.body?.privacy_policy ?? undefined,
      registrationCertBodySupportUri: registrationCert?.body?.support_uri ?? undefined,
      registrationCertBodyIntermediary: registrationCert?.body?.intermediary ?? undefined,
    });

    while (this.registrationCertPurposeArray.length > 0) {
      this.registrationCertPurposeArray.removeAt(0);
    }

    const purposes = Array.isArray(registrationCert?.body?.purpose)
      ? registrationCert.body.purpose
      : [];

    for (const purpose of purposes) {
      this.addRegistrationCertPurpose(
        purpose?.lang || '',
        purpose?.content || purpose?.value || ''
      );
    }

    if (registrationCert?.jwt || registrationCert?.id) {
      this.registrationCertTabIndex = 0;
      return;
    }

    if (registrationCert?.body) {
      this.registrationCertTabIndex = 1;
    }
  }
}
