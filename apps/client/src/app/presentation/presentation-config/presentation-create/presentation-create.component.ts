import {
  DEFAULT_LANGUAGE,
  firstUnusedLanguage,
  languageOptionsWith,
} from '../../../utils/language-options';
import {
  HostListener,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { focusAfterRenderIfLost, focusRowAfterRemoval } from '../../../common/focus-if-lost.util';
import { firstFieldWithError, focusFieldToFix } from '../../../common/field-to-fix.util';
import { httpUrlValidator } from '../../../utils/http-url-validator';
import {
  AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  presentationManagementControllerUpdateConfiguration,
  keyChainControllerGetAll,
  defaultAccessKeyChainControllerGet,
  type DefaultAccessKeyChainDto,
  webhookEndpointControllerGetAll,
  KeyChainResponseDto,
  WebhookEndpointEntity,
  type PresentationRegistrationCertificate,
} from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../presentation-management.service';
import { MatDialog } from '@angular/material/dialog';
import { JsonViewDialogComponent } from '../../../issuance/credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { TenantCredentialCatalogService } from '../issuer-metadata-browser/tenant-credential-catalog.service';
import type { NormalizedCredential } from '../issuer-metadata-browser/issuer-metadata.service';
import {
  IssuerMetadataBrowserComponent,
  type IssuerMetadataBrowserDialogData,
} from '../issuer-metadata-browser/issuer-metadata-browser.component';
import { SchemaBrowserComponent } from '../schema-browser/schema-browser.component';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDividerModule } from '@angular/material/divider';
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
  getRegistrationCertTimes,
  registrationCertStatusSentence,
  type RegistrationCertStatus,
} from '../../../utils/registration-cert-status';
import { CredentialIdsComponent } from '../../credential-ids/credential-ids.component';
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
import { getApiErrorMessage, hasHttpStatus } from '../../../utils/error-message';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { jsonViewUnavailableReason } from '../../../common/json-view';
import type { PageWithUnsavedChanges } from '../../../services/unsaved-changes.service';

/**
 * How many credentials a DCQL query in the editor asks for: 0 when it is
 * empty, 'unreadable' when it is text that does not parse.
 */
function dcqlCredentialCount(value: unknown): number | 'unreadable' {
  let query: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return 0;
    try {
      query = extractSchema(value);
    } catch {
      return 'unreadable';
    }
  }
  const credentials = (query as { credentials?: unknown } | null | undefined)?.credentials;
  return Array.isArray(credentials) ? credentials.length : 0;
}

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
    ReactiveFormsModule,
    RouterModule,
    MatMenuModule,
    MatDividerModule,
    MatTabsModule,
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
export class PresentationCreateComponent implements OnInit, PageWithUnsavedChanges {
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
  /** IDs of the existing configs; the backend refuses to create one with a taken ID. */
  private takenIds = new Set<string>();
  /** The existing configs could not be listed, so a taken ID shows only when saving. */
  takenIdsUnknown = false;

  /** Where the back link and Cancel lead: the config being edited, or the list. */
  get backLink(): string[] {
    return this.copyMode ? ['../../'] : ['../'];
  }

  /** Name of the page the back link leads to. */
  get backLabel(): string {
    const id: string | undefined = this.route.snapshot.params['id'];
    return id && !this.copyMode ? id : 'Verification Configs';
  }
  public guided = true;
  public activeStep = 0;
  public furthestStep = 0;
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
    'Check the verification config before saving',
  ];

  transactionDataArraySchema = transactionDataArraySchema;

  public predefinedConfigs = configs;

  public keyChains: KeyChainResponseDto[] = [];
  public webhookEndpoints: WebhookEndpointEntity[] = [];

  readonly languageOptionsWith = languageOptionsWith;

  private readonly injector = inject(Injector);
  private readonly credentialCatalog = inject(TenantCredentialCatalogService);
  /** The credential configs this tenant issues, for hints in the query builder. */
  knownCredentials: NormalizedCredential[] = [];
  /** Takes the focus after a successful Retry, which removed the focused Retry button. */
  @ViewChild('pageHeading', { read: ElementRef })
  private readonly pageHeading?: ElementRef<HTMLElement>;
  /** The form, whose steps hold the fields to fix after a refused Continue or Save. */
  @ViewChild('editorForm', { read: ElementRef })
  private readonly editorForm?: ElementRef<HTMLFormElement>;
  /** The purpose text of each row, which takes focus after a removal. */
  @ViewChildren('purposeContent', { read: ElementRef })
  private readonly purposeContents?: QueryList<ElementRef<HTMLElement>>;
  /** The attachment rows, whose first field takes focus after a removal. */
  @ViewChildren(CredentialIdsComponent, { read: ElementRef })
  private readonly attachmentRows?: QueryList<ElementRef<HTMLElement>>;
  @ViewChild('addAttachmentButton', { read: ElementRef })
  private readonly addAttachmentButton?: ElementRef<HTMLElement>;
  @ViewChild('addPurposeButton', { read: ElementRef })
  private readonly addPurposeButton?: ElementRef<HTMLElement>;

  constructor(
    private readonly presentationService: PresentationManagementService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog
  ) {
    this.form = new FormGroup({
      id: new FormControl(undefined, [
        Validators.required,
        (control: AbstractControl): ValidationErrors | null =>
          this.takenIds.has(control.value) ? { taken: true } : null,
      ]),
      description: new FormControl(undefined, [Validators.required]),
      redirectUri: new FormControl(undefined),
      allowedOrigins: new FormControl('', [allowedOriginsValidator]),
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
      registrationCertJwt: new FormControl(undefined),
      registrationCertPrivacyPolicy: new FormControl(undefined, [
        Validators.maxLength(2048),
        httpUrlValidator,
      ]),
      registrationCertPurpose: new FormArray([]),
      transaction_data: new FormControl(undefined, [
        schemaFormValidator(transactionDataArraySchema),
      ]),
      attached: new FormArray([]),
      webhookEndpointId: new FormControl(''), // Predefined webhook endpoint selector
    });
  }

  ngOnInit(): void {
    this.guided = !this.route.snapshot.params['id'];
    this.loadKnownCredentials();

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
      // From the route's data, not its URL: a config may be called "copy".
      this.copyMode = this.route.snapshot.data?.['copy'] === true;
      // An edit page stays one while it loads, also when the load fails.
      this.create = this.copyMode;
      this.loadConfigForEdit();
    }
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty;
  }

  /** Loads the configuration to edit or copy; on failure the form stays hidden behind a retry. */
  loadConfigForEdit(): void {
    const retrying = this.loadError !== '';
    this.loadingConfig = true;
    this.loadError = '';
    this.presentationService
      .getPresentationById(this.route.snapshot.params['id'])
      .then(
        async (config) => {
          if (!config) {
            this.snackBar.open('Verification config not found', 'Close', {
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

          if (formData.transaction_data && typeof formData.transaction_data === 'object') {
            formData.transaction_data = JSON.stringify(formData.transaction_data, null, 2);
          }

          formData.allowedOrigins = formatAllowedOrigins(formData.allowedOrigins);

          (formData.attached || []).forEach(() => this.addAttachment());

          // Remove inline webhook config since we only support webhook endpoint references
          delete formData.webhook;

          if (this.copyMode) {
            // The copy gets its own ID, which stays editable; the rest of the form is the source's.
            this.form.patchValue(formData);
            await this.applyCopyId(config.id);
            this.create = true;
          } else {
            // Edit mode: disable ID field
            this.form.patchValue(formData);
            this.form.get('id')?.disable();
            this.create = false;
          }
          // The retry removed the error card with its focused Retry button.
          if (retrying) {
            focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
          }
        },
        (error) => {
          console.error('Error loading verification config:', error);
          this.loadError = getApiErrorMessage(error, 'Failed to load verification config');
        }
      )
      .finally(() => (this.loadingConfig = false));
  }

  /**
   * Sets the copy's ID to `<source>-copy`, or `<source>-copy-2` and so on when that is taken:
   * the backend refuses to create a config with an existing ID. Without the list of configs
   * the first suggestion stays, and saving tells whether it is taken.
   */
  private async applyCopyId(sourceId: string): Promise<void> {
    try {
      const configs = await this.presentationService.loadConfigurations();
      for (const config of configs ?? []) this.takenIds.add(config.id);
    } catch (error) {
      console.error('Error loading verification configs for the copy ID:', error);
      this.takenIdsUnknown = true;
    }
    let id = `${sourceId}-copy`;
    for (let n = 2; this.takenIds.has(id); n++) id = `${sourceId}-copy-${n}`;
    this.form.get('id')?.setValue(id);
  }

  /**
   * Marks the ID the backend refused as taken (409) and shows the field with its error, as a
   * refused local check does.
   */
  private markIdTaken(id: string): void {
    this.takenIds.add(id);
    const control = this.form.get('id');
    control?.updateValueAndValidity();
    control?.markAsTouched();
    this.activeStep = 0;
    this.focusStepFieldToFix(0, () => undefined);
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
    const referenceError = step === 2 ? this.integrationReference : null;
    if (referenceError) {
      this.validationMessage = referenceError.message;
      this.focusStepFieldToFix(step, () => this.referenceField(referenceError.section));
      return false;
    }
    if (controls.some((control) => control.invalid)) {
      // The query builder shows its errors as messages next to its fields, not as invalid fields.
      this.validationMessage =
        step === 1
          ? 'Check the errors in Credentials.'
          : `Check the highlighted fields in ${['Name', 'Credentials', 'Settings'][step]}.`;
      this.focusStepFieldToFix(step, () => (step === 1 ? this.queryErrorField() : undefined));
      return false;
    }
    this.validationMessage = '';
    return true;
  }

  /** The element of a step of the editor; the steps stay rendered once shown. */
  private stepElement(step: number): HTMLElement | null | undefined {
    return this.editorForm?.nativeElement.querySelector<HTMLElement>(`[data-step="${step}"]`);
  }

  /**
   * After the step is shown, moves focus to `field`, else to the step's first field with an error,
   * which the refused Continue or Save may have left in another step, out of view.
   */
  private focusStepFieldToFix(step: number, field: () => HTMLElement | null | undefined): void {
    focusFieldToFix(this.injector, () => this.stepElement(step), {
      field: () => field() ?? firstFieldWithError(this.stepElement(step)),
    });
  }

  /**
   * The first field of the query builder's credential that shows an error, else the first field
   * of the builder or of its JSON editor.
   */
  private queryErrorField(): HTMLElement | null | undefined {
    const editor = this.stepElement(1)?.querySelector<HTMLElement>('app-dcql-query-editor');
    const scope = editor?.querySelector('.query-error')?.closest<HTMLElement>('fieldset') ?? editor;
    return (
      scope?.querySelector<HTMLElement>('app-editor, input, textarea, mat-select') ??
      editor?.querySelector<HTMLElement>('button')
    );
  }

  /** Where a missing credential reference is fixed: the attachments or the transaction data. */
  private referenceField(
    section: 'Attachments' | 'Transaction data'
  ): HTMLElement | null | undefined {
    const settings = this.stepElement(2);
    if (section === 'Transaction data') {
      return settings?.querySelector<HTMLElement>('app-editor[formcontrolname="transaction_data"]');
    }
    return (
      settings?.querySelector<HTMLElement>(
        '[formarrayname="attached"] input, [formarrayname="attached"] textarea'
      ) ?? this.addAttachmentButton?.nativeElement
    );
  }

  nextStep(): void {
    if (this.activeStep >= 3 || !this.validateStep(this.activeStep)) return;
    this.furthestStep = Math.max(this.furthestStep, this.activeStep + 1);
    this.activeStep++;
  }

  previousStep(): void {
    // Back waits for a running save, like Save, and stays focusable while it does.
    if (this.saving) return;
    this.activeStep = Math.max(0, this.activeStep - 1);
  }

  submitPresentation(): void {
    if (this.loadingConfig || this.loadError) return;
    if (this.guided && this.activeStep < 3) {
      this.nextStep();
      return;
    }
    this.createOrUpdatePresentation();
  }

  /** Origin of this Web Client, which DC API requests started from it need in the list. */
  readonly pageOrigin = window.location.origin;

  /** What the Review step shows for the allowed origins: the list that will be saved. */
  get allowedOriginsSummary(): string {
    const origins = parseAllowedOrigins(this.form.get('allowedOrigins')?.value);
    return origins.length ? origins.join(', ') : NO_ALLOWED_ORIGINS;
  }

  /**
   * Summary of the registration certificate settings for the Review step: it names a JWT only
   * when there is one.
   */
  get registrationCertSummary(): string {
    const registrationCert = this.buildRegistrationCertFromForm();
    if (!registrationCert) return 'Not configured';
    if (!registrationCert.jwt) return 'Purpose only, no certificate';
    return (
      registrationCertStatusSentence(this.registrationCertStatus, this.registrationCertExpiresIn) ??
      'Configured'
    );
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
        return 'The default access key chain of the tenant does not exist. Choose another one under Keys, or select an access key chain here.';
      }
      return chain.activeCertificate?.pem
        ? null
        : 'The default access key chain has no active access certificate. Create or refresh it under Keys, or select another access key chain here.';
    }
    const chains = selected
      ? this.keyChains.filter((chain) => chain.id === selected)
      : this.keyChains;
    return chains.some((chain) => chain.activeCertificate?.pem)
      ? null
      : 'An access key chain with an active certificate is needed to create verification requests.';
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
        claims: this.claimsSummary(credential.claims),
      }));
  }

  /** Omitted claims summarise as none requested; `[]` and non-arrays are invalid. */
  private claimsSummary(claims: unknown): string[] {
    if (claims === undefined) return [];
    if (!Array.isArray(claims)) return ['Invalid claims list'];
    if (!claims.length) return ['Empty claims list: remove "claims" to request no claims'];
    return claims.map((claim: any) =>
      Array.isArray(claim?.path)
        ? claim.path
            .map((part: unknown) => (typeof part === 'number' ? `[${part}]` : String(part)))
            .join(' › ') +
          (Array.isArray(claim.values)
            ? ` — allowed values: ${claim.values.map((value: unknown) => JSON.stringify(value)).join(', ')}`
            : '') +
          (typeof claim.intent_to_retain === 'boolean'
            ? ` — retain: ${claim.intent_to_retain ? 'yes' : 'no'}`
            : '')
        : 'Invalid claim path'
    );
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

  /**
   * The first attachment or transaction data entry that names a credential the query lacks:
   * renamed or deleted query IDs must also be repaired in the integration settings before saving.
   */
  private get integrationReference(): {
    message: string;
    section: 'Attachments' | 'Transaction data';
  } | null {
    const query = parseDcql(this.queryControl.value) as any;
    const ids = new Set(
      Array.isArray(query?.credentials) ? query.credentials.map((entry: any) => entry?.id) : []
    );
    const transactions = parseDcql(this.form.get('transaction_data')?.value);
    const entries = [
      ...this.getFormArray('attached')
        .getRawValue()
        .map((entry: any) => ({ entry, section: 'Attachments' as const })),
      ...(Array.isArray(transactions)
        ? transactions.map((entry) => ({ entry, section: 'Transaction data' as const }))
        : []),
    ];
    for (const { entry, section } of entries) {
      if (!Array.isArray(entry?.credential_ids)) continue;
      const missing = entry.credential_ids.find((id: unknown) => !ids.has(id));
      if (missing !== undefined)
        return {
          message: `${section} references missing credential "${missing}". Update its credential IDs in Settings.`,
          section,
        };
    }
    return null;
  }

  getFormArray(value: string) {
    return this.form.get(value) as FormArray;
  }

  /** Adds an empty attachment row; loading uses it too, so it leaves the form pristine. */
  addAttachment(): void {
    this.getFormArray('attached').push(
      new FormGroup({
        format: new FormControl(undefined, [Validators.required]),
        data: new FormControl(undefined, [Validators.required]),
        credential_ids: new FormControl(),
      })
    );
  }

  /** Add Attachment: a new, empty attachment, which is an unsaved change. */
  addAttachmentByUser(): void {
    this.addAttachment();
    this.form.markAsDirty();
  }

  /** Removes an attachment; focus moves to the row now in its place, else to Add Attachment. */
  removeAttachment(index: number) {
    (this.form.get('attached') as FormArray).removeAt(index);
    this.form.markAsDirty();
    focusRowAfterRemoval(
      this.injector,
      () =>
        this.attachmentRows
          ?.map((row) => row.nativeElement.querySelector<HTMLElement>('input'))
          .filter((input): input is HTMLElement => !!input),
      index,
      () => this.addAttachmentButton?.nativeElement
    );
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

  /** Save and Back stay focusable while a save runs, so their tooltip says why they wait. */
  get saveTooltip(): string {
    return this.saving ? 'Saving the verification config…' : '';
  }

  createOrUpdatePresentation(): void {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
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
            this.form.markAsPristine();
            // In copy mode, navigate up two levels (past :id/copy), otherwise one level
            const navigatePath = this.copyMode ? ['../../', res.id] : ['../', res.id];
            this.router.navigate(navigatePath, { relativeTo: this.route });
            this.snackBar.open('Verification config created successfully', 'Close', {
              duration: 3000,
            });
          },
          (err: unknown) => {
            if (hasHttpStatus(err, 409)) {
              this.markIdTaken(formValue.id);
              openErrorSnackBar(
                this.snackBar,
                `A verification config with ID '${formValue.id}' already exists. Choose another ID.`
              );
              return;
            }
            openErrorSnackBar(
              this.snackBar,
              getApiErrorMessage(err, 'Failed to create verification config', { allIssues: true })
            );
          }
        )
        .finally(() => (this.saving = false));
    } else {
      presentationManagementControllerUpdateConfiguration({
        body: formValue,
        path: { id: formValue.id },
      })
        .then(
          () => {
            this.form.markAsPristine();
            this.router.navigate(['../'], { relativeTo: this.route });
            this.snackBar.open('Verification config updated successfully', 'Close', {
              duration: 3000,
            });
          },
          (err: unknown) => {
            openErrorSnackBar(
              this.snackBar,
              getApiErrorMessage(err, 'Failed to save verification config', { allIssues: true })
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

  /** Why JSON View cannot be opened right now, or '' when it can; its tooltip. */
  get jsonViewUnavailableReason(): string {
    return jsonViewUnavailableReason(
      { loading: this.loadingConfig, loadError: this.loadError, saving: this.saving },
      'the verification config'
    );
  }

  /**
   * Show/Edit the entire presentation config as JSON
   */
  viewAsJson(): void {
    // The button stays clickable while it cannot be used (disabledInteractive).
    if (this.jsonViewUnavailableReason) return;
    const currentConfig = this.getCompleteConfiguration();
    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Verification Config JSON',
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

    delete formValue.registrationCertJwt;
    delete formValue.registrationCertPrivacyPolicy;
    delete formValue.registrationCertPurpose;

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

    formValue.registration_cert = this.buildRegistrationCertFromForm();
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

    const allowedOrigins = parseAllowedOrigins(formValue.allowedOrigins);
    // null clears the list on update; exports leave an empty list out
    formValue.allowedOrigins = allowedOrigins.length
      ? allowedOrigins
      : forExport
        ? undefined
        : null;

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

  /**
   * An import replaces the whole DCQL query. When the current one already asks
   * for credentials, or is text that does not parse, the user confirms before
   * the picker opens, so neither a query built by hand nor a selection made in
   * the picker is lost to a click.
   */
  private confirmReplacingQuery(importName: string): boolean {
    const count = dcqlCredentialCount(this.form.get('dcql_query')?.value);
    if (count === 0) {
      return true;
    }
    let current = 'which cannot be read as DCQL';
    if (count !== 'unreadable') {
      current = count === 1 ? 'which asks for 1 credential' : `which asks for ${count} credentials`;
    }
    return confirm(`${importName} replaces the current query, ${current}. Continue?`);
  }

  /**
   * Whether the form holds anything a template would replace: a template
   * resets every setting except ID and Description.
   */
  private hasSettingsBeyondName(): boolean {
    const value = this.form.getRawValue();
    const filled = (field: unknown) =>
      field !== undefined && field !== null && `${field}`.trim() !== '';
    return (
      dcqlCredentialCount(value.dcql_query) !== 0 ||
      [
        value.redirectUri,
        value.allowedOrigins,
        value.accessKeyChainId,
        value.registrationCertJwt,
        value.registrationCertPrivacyPolicy,
        value.transaction_data,
        value.webhookEndpointId,
      ].some(filled) ||
      value.registrationCertPurpose.length > 0 ||
      value.attached.length > 0 ||
      value.lifeTime !== 300 ||
      value.statusCheckMode !== 'strict'
    );
  }

  /**
   * Loads the credential configs of this tenant for the query builder hints,
   * again when the user returns to this tab, where a credential config may
   * have been created in the meantime.
   */
  @HostListener('window:focus')
  loadKnownCredentials(): void {
    void this.credentialCatalog.load().then((credentials) => {
      this.knownCredentials = credentials;
    });
  }

  /**
   * Load a predefined configuration
   */
  loadPredefinedConfig(configTemplate: any): void {
    if (
      this.hasSettingsBeyondName() &&
      !confirm(
        `Load the template "${configTemplate.name}"? It replaces all settings except ID and Description.`
      )
    ) {
      return;
    }
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
      formData.allowedOrigins = formatAllowedOrigins(formData.allowedOrigins);
      const existingId = this.form.get('id')?.value;
      this.getFormArray('attached').clear();
      this.registrationCertPurposeArray.clear();
      this.form.reset({ lifeTime: 300, statusCheckMode: 'strict', webhookEndpointId: '' });
      this.loadRegistrationCertIntoForm(registrationCert);
      (formData.attached || []).forEach(() => this.addAttachment());
      this.form.patchValue(formData);
      if (!this.create) this.form.get('id')?.setValue(existingId);
      this.form.markAsDirty();
      this.snackBar.open('Verification config loaded from JSON', 'OK', {
        duration: 3000,
      });
    } catch (error) {
      console.error('Error loading configuration from JSON:', error);
      this.snackBar.open('Could not load the verification config from JSON', 'Close', {
        duration: 3000,
      });
    }
  }

  /**
   * Open the issuer metadata browser dialog to import DCQL from an issuer
   */
  importFromIssuer(): void {
    if (!this.confirmReplacingQuery('Import from Issuer')) return;
    this.openClaimPicker({}, 'DCQL query imported from issuer');
  }

  /**
   * Open the same claim picker on the credential configs this tenant issues, so
   * the query asks only for credential types and claims that exist.
   */
  importFromCredentialConfig(): void {
    if (!this.confirmReplacingQuery('Import from Credential Config')) return;
    this.openClaimPicker({ source: 'tenant' }, 'DCQL query imported from credential config');
  }

  private openClaimPicker(data: IssuerMetadataBrowserDialogData, importedMessage: string): void {
    const dialogRef = this.dialog.open(IssuerMetadataBrowserComponent, {
      data,
      disableClose: false,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe((dcqlQuery) => {
      if (dcqlQuery) {
        // Set the DCQL query in the form
        this.form.get('dcql_query')?.setValue(JSON.stringify(dcqlQuery, null, 2));
        this.form.get('dcql_query')?.markAsDirty();
        this.snackBar.open(importedMessage, 'OK', {
          duration: 3000,
        });
      }
    });
  }

  /**
   * Open the schema metadata browser dialog to import DCQL from schema metadata.
   */
  importFromSchemaMetadata(): void {
    if (!this.confirmReplacingQuery('Import from Schema')) return;
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
        this.form.get('dcql_query')?.markAsDirty();

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
    return this.form.get('registrationCertPurpose') as FormArray;
  }

  /** The first language no purpose is written in yet, for the next one. */
  get unusedPurposeLanguage(): string {
    return (
      firstUnusedLanguage(
        this.registrationCertPurposeArray.controls.map((purpose) => purpose.get('lang')?.value)
      ) ?? DEFAULT_LANGUAGE
    );
  }

  /** Adds a purpose row; loading uses it too, so it leaves the form pristine. */
  addRegistrationCertPurpose(lang = DEFAULT_LANGUAGE, value = ''): void {
    // Any stored tag is kept, also one the list lacks such as pt-BR; only a
    // missing one becomes the default.
    const normalizedLang = lang || DEFAULT_LANGUAGE;

    this.registrationCertPurposeArray.push(
      new FormGroup({
        lang: new FormControl(normalizedLang, [Validators.required]),
        content: new FormControl(value, [Validators.required]),
      })
    );
  }

  /** Add Purpose: a new purpose in a language no purpose has yet, which is an unsaved change. */
  addPurposeByUser(): void {
    this.addRegistrationCertPurpose(this.unusedPurposeLanguage);
    this.form.markAsDirty();
  }

  /** Removes a purpose; focus moves to the row now in its place, else to Add Purpose. */
  removeRegistrationCertPurpose(index: number): void {
    this.registrationCertPurposeArray.removeAt(index);
    this.form.markAsDirty();
    focusRowAfterRemoval(
      this.injector,
      () => this.purposeContents?.map((content) => content.nativeElement),
      index,
      () => this.addPurposeButton?.nativeElement
    );
  }

  /**
   * The DCQL query was edited while the form holds a registration certificate
   * JWT, which may no longer cover it; saving then fails.
   */
  get dcqlChangedWithCertificate(): boolean {
    return (
      this.queryControl.dirty && !!`${this.form.get('registrationCertJwt')?.value ?? ''}`.trim()
    );
  }

  /** Status of the registration certificate the form holds, read from its JWT. */
  get registrationCertStatus(): RegistrationCertStatus {
    return getRegistrationCertStatus({ registration_cert: this.buildRegistrationCertFromForm() });
  }

  get registrationCertExpiresIn(): string | null {
    return formatRegistrationCertExpiresIn(
      getRegistrationCertTimes({ registration_cert: this.buildRegistrationCertFromForm() })
    );
  }

  /**
   * The `registration_cert` the form describes: the JWT from a registrar and
   * the purpose and privacy policy it is requested with. Null when all are empty.
   */
  private buildRegistrationCertFromForm(): PresentationRegistrationCertificate | null {
    const jwt = `${this.form.get('registrationCertJwt')?.value ?? ''}`.trim();
    const privacyPolicy = `${this.form.get('registrationCertPrivacyPolicy')?.value ?? ''}`.trim();
    const purpose = this.registrationCertPurposeArray.controls
      .map((ctrl) => ({
        lang: `${ctrl.get('lang')?.value ?? ''}`.trim(),
        content: `${ctrl.get('content')?.value ?? ''}`.trim(),
      }))
      .filter((entry) => entry.lang && entry.content);
    const registrationCert: PresentationRegistrationCertificate = {
      ...(jwt ? { jwt } : {}),
      ...(purpose.length ? { purpose } : {}),
      ...(privacyPolicy ? { privacy_policy: privacyPolicy } : {}),
    };
    return Object.keys(registrationCert).length ? registrationCert : null;
  }

  /**
   * Fills the registration certificate fields. A file of an earlier version
   * kept the purpose and privacy policy under `body`; they are read from
   * there too.
   */
  private loadRegistrationCertIntoForm(registrationCert: any): void {
    this.form.patchValue({
      registrationCertJwt: registrationCert?.jwt ?? undefined,
      registrationCertPrivacyPolicy:
        registrationCert?.privacy_policy ?? registrationCert?.body?.privacy_policy ?? undefined,
    });

    this.registrationCertPurposeArray.clear();
    // Files saved before the body was removed keep the purpose under it.
    let purposes: { lang?: string; content?: string }[] = [];
    if (Array.isArray(registrationCert?.purpose)) {
      purposes = registrationCert.purpose;
    } else if (Array.isArray(registrationCert?.body?.purpose)) {
      purposes = registrationCert.body.purpose;
    }
    for (const purpose of purposes) {
      this.addRegistrationCertPurpose(purpose?.lang || '', purpose?.content || '');
    }
  }
}

const NO_ALLOWED_ORIGINS = 'Not restricted';

/** Origins entered one per line (commas also separate them). */
function parseAllowedOrigins(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formatAllowedOrigins(value: unknown): string {
  return parseAllowedOrigins(value).join('\n');
}

/** The pattern of the backend schema: lower-case host or IP address, no default port. */
const SERIALIZED_ORIGIN_PATTERN =
  /^(?:https:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(?:[1-9]|[1-9][0-9]|[1-35-9][0-9]{2}|4[0-35-9][0-9]|44[0-24-9]|[1-9][0-9]{3,4}))?|http:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(?:[1-9]|[1-79][0-9]|8[1-9]|[1-9][0-9]{2,4}))?)$/;
const MAX_ALLOWED_ORIGINS = 100;

/** Mirrors the backend rule: an http(s) origin in serialized form. */
function isSerializedWebOrigin(value: string): boolean {
  if (!SERIALIZED_ORIGIN_PATTERN.test(value)) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function allowedOriginsValidator(control: AbstractControl): ValidationErrors | null {
  const origins = parseAllowedOrigins(control.value);
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    return { tooManyOrigins: MAX_ALLOWED_ORIGINS };
  }
  const invalid = origins.filter((entry) => !isSerializedWebOrigin(entry));
  if (!invalid.length) return null;
  const shown = invalid.slice(0, 2).join(', ');
  return {
    invalidOrigins: invalid.length > 2 ? `${shown} and ${invalid.length - 2} more` : shown,
  };
}
