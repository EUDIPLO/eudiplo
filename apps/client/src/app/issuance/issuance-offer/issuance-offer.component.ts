import {
  ChangeDetectorRef,
  Component,
  ViewChild,
  type OnInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  UntypedFormGroup,
  Validators,
  FormsModule,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  AttributeProviderEntity,
  CredentialConfig,
  deriveRuntimeArtifacts,
  type IssuanceConfig,
  type OfferRequestDto,
} from '@eudiplo/sdk-core';
import { IssuanceConfigService } from '../issuance-config/issuance-config.service';
import { AttributeProviderService } from '../attribute-provider/attribute-provider.service';
import { FormlyJsonschema } from '@ngx-formly/core/json-schema';
import { CredentialConfigService } from '../credential-config/credential-config.service';
import { FormlyFieldConfig, FormlyFieldProps, FormlyModule } from '@ngx-formly/core';
import { MatDividerModule } from '@angular/material/divider';
import { JsonViewDialogComponent } from '../credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { STEPPER_GLOBAL_OPTIONS } from '@angular/cdk/stepper';
import { CommonModule } from '@angular/common';
import { getApiErrorMessage } from '../../utils/error-message';

/**
 * Custom validator to check that array has at least one element
 */
function arrayNotEmpty(control: AbstractControl): ValidationErrors | null {
  const value = control.value;
  if (!value || !Array.isArray(value) || value.length === 0) {
    return { required: true };
  }
  return null;
}

@Component({
  selector: 'app-issuance-offer',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    RouterModule,
    FormlyModule,
    MatDividerModule,
    MatDialogModule,
    MatRadioModule,
    MatStepperModule,
  ],
  providers: [
    {
      provide: STEPPER_GLOBAL_OPTIONS,
      useValue: { showError: true },
    },
  ],
  templateUrl: './issuance-offer.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./issuance-offer.component.scss'],
})
export class IssuanceOfferComponent implements OnInit {
  @ViewChild('stepper') stepper!: MatStepper;

  // Step form groups
  flowStepForm: FormGroup;
  credentialStepForm: FormGroup;
  configStepForm: FormGroup;

  form: FormGroup;
  loading = false;
  generatingOffer = false;

  formValues = new FormGroup({});
  fields: FormlyFieldConfig<FormlyFieldProps & Record<string, any>>[] = [];
  model: any = {};

  elements: {
    id: string;
    defaultClaims?: any; // Default claims from config for pre-filling
    attributeProviderId?: string; // Attribute provider ID from credential config
    claimSource: string; // 'form' or 'attributeProvider'
  }[] = [];
  credentialConfigs: CredentialConfig[] = [];
  issuanceConfig?: IssuanceConfig;
  availableAuthServers: string[] = [];
  availableManagedAuthorizationServers: { value: string; label: string }[] = [];
  hasChainedAuthorizationServer = false;
  availableAttributeProviders: AttributeProviderEntity[] = [];

  // IAE status tracking for selected credential configs
  selectedConfigsIaeStatus = new Map<string, boolean>();

  // Webhook FormGroups for external AS flow (keyed by credential config id)
  externalAsWebhooks = new Map<string, FormGroup>();

  /**
   * Returns the selected flow type
   */
  get selectedFlow(): string {
    return this.flowStepForm.get('flow')?.value || 'pre_authorized_code';
  }

  /**
   * Returns true if pre-authorized code flow is selected
   */
  get isPreAuthFlow(): boolean {
    return this.selectedFlow === 'pre_authorized_code';
  }

  /**
   * Returns true if authorization code flow with external AS is selected
   */
  get isAuthCodeExternalFlow(): boolean {
    return this.selectedFlow === 'authorization_code_external';
  }

  get hasHostedAuthorizationServers(): boolean {
    return this.availableManagedAuthorizationServers.length > 0;
  }

  /**
   * Returns true if IAE flow (auth code with built-in AS) is selected
   */
  get isIaeFlow(): boolean {
    return this.selectedFlow === 'authorization_code_iae';
  }

  /**
   * Returns true if any authorization code flow is selected (external or IAE)
   */
  get isAuthCodeFlow(): boolean {
    return this.isAuthCodeExternalFlow || this.isIaeFlow;
  }

  /**
   * Returns credentials with IAE configured
   */
  get configsWithIae(): string[] {
    const selectedIds = this.credentialStepForm.get('credentialConfigurationIds')?.value || [];
    return selectedIds.filter((id: string) => this.selectedConfigsIaeStatus.get(id) === true);
  }

  /**
   * Returns credential configs available for selection based on the selected flow.
   * - Pre-auth flow: Only configs WITHOUT IAE
   * - Auth-code external flow: Only configs WITHOUT IAE (external AS handles auth)
   * - IAE flow: Only configs WITH IAE (built-in AS uses IAE)
   */
  get availableCredentialConfigs(): CredentialConfig[] {
    if (this.isIaeFlow) {
      // For IAE flow, only show configs WITH IAE
      return this.credentialConfigs.filter((config) => config.iaeActions?.length);
    }
    // For pre-auth and external AS flows, only show configs WITHOUT IAE
    return this.credentialConfigs.filter((config) => !config.iaeActions?.length);
  }

  /**
   * Returns true if there are credential configs available for the selected flow
   */
  get hasAvailableConfigs(): boolean {
    return this.availableCredentialConfigs.length > 0;
  }

  /**
   * Returns the webhook FormGroup for a specific credential config (external AS flow)
   */
  getWebhookFormGroup(configId: string): FormGroup | undefined {
    return this.externalAsWebhooks.get(configId);
  }

  /**
   * Returns true if all attribute providers for external AS flow are configured
   */
  get allExternalAsWebhooksValid(): boolean {
    const selectedIds = this.credentialStepForm.get('credentialConfigurationIds')?.value || [];
    return selectedIds.every((id: string) => {
      const apForm = this.externalAsWebhooks.get(id);
      return apForm?.get('attributeProviderId')?.value; // Attribute provider must be set
    });
  }

  constructor(
    private readonly issuanceConfigService: IssuanceConfigService,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly formlyJsonschema: FormlyJsonschema,
    private readonly credentialConfigService: CredentialConfigService,
    private readonly attributeProviderService: AttributeProviderService,
    private readonly dialog: MatDialog,
    private readonly cdr: ChangeDetectorRef
  ) {
    // Step 1: Flow selection
    this.flowStepForm = new FormGroup({
      flow: new FormControl('pre_authorized_code', Validators.required),
    });

    // Step 2: Credential selection
    this.credentialStepForm = new FormGroup({
      credentialConfigurationIds: new FormControl([], [arrayNotEmpty]),
    });

    // Step 3: Flow-specific configuration (claims for pre-auth, AS for auth-code)
    this.configStepForm = new FormGroup({
      claims: new FormGroup({}),
      tx_code: new FormControl(''),
      tx_code_description: new FormControl(''),
      authorization_server: new FormControl(''),
    });

    // Legacy form reference (not used with stepper, kept for backward compatibility)
    this.form = new FormGroup({});
  }

  async ngOnInit() {
    // Load required data first
    const [configs, , issuanceConfig] = await Promise.all([
      this.credentialConfigService.loadConfigurations(),
      this.attributeProviderService
        .getAll()
        .then((providers) => (this.availableAttributeProviders = providers))
        .catch(() => (this.availableAttributeProviders = [])),
      this.issuanceConfigService.getConfig(),
    ]);

    this.credentialConfigs = configs;
    this.issuanceConfig = issuanceConfig;
    this.availableAuthServers = ((issuanceConfig as any)?.authorizationServers || [])
      .filter((server: any) => server?.type === 'external' && !!server?.issuer)
      .map((server: any) => server.issuer);
    this.availableManagedAuthorizationServers = (
      (issuanceConfig as any)?.authorizationServers || []
    )
      .filter((server: any) => server?.type === 'oid4vp' && !!server?.id)
      .map((server: any) => ({
        value: server.id,
        label: server.label || server.id,
      }));
    this.hasChainedAuthorizationServer = ((issuanceConfig as any)?.authorizationServers || []).some(
      (server: any) => server?.type === 'chained' && server?.enabled !== false
    );
    this.syncAuthorizationServerControl(this.selectedFlow);

    // Check for pre-fill data from navigation state (recreate offer flow)
    // Must be done BEFORE setting up subscriptions to avoid interference
    const prefillData = history.state?.offerRequest as OfferRequestDto | undefined;
    if (prefillData) {
      await this.prefillFromOffer(prefillData);
    } else {
      // Auto-select if only one configuration is available
      if (this.credentialConfigs.length === 1) {
        this.credentialStepForm.patchValue({
          credentialConfigurationIds: [this.credentialConfigs[0].id],
        });
        await this.setClaimFormFields([this.credentialConfigs[0].id]);
      }
    }

    // Listen for credential config selection changes
    this.credentialStepForm
      .get('credentialConfigurationIds')
      ?.valueChanges.subscribe((ids) => this.setClaimFormFields(ids));

    // Reset configuration step when flow changes
    this.flowStepForm.get('flow')?.valueChanges.subscribe((flow) => {
      // Clear selected credential configs since available configs change based on flow
      this.credentialStepForm.patchValue({
        credentialConfigurationIds: [],
      });
      this.selectedConfigsIaeStatus.clear();
      this.externalAsWebhooks.clear();
      this.configStepForm.patchValue({
        authorization_server: this.getDefaultAuthServerForFlow(flow),
        tx_code: '',
      });
      this.syncAuthorizationServerControl(flow);
    });

    this.credentialStepForm.get('credentialConfigurationIds')?.valueChanges.subscribe(() => {
      this.syncAuthorizationServerControl(this.selectedFlow);
    });

    // Pre-select preferred AS if set and we're already on auth-code-external flow (and not prefilling)
    if (
      !prefillData &&
      (this.isAuthCodeExternalFlow || this.isPreAuthFlow) &&
      (this.authCodeAuthorizationServerOptions.length > 0 ||
        this.preAuthAuthorizationServerOptions.length > 0)
    ) {
      this.configStepForm.patchValue({
        authorization_server: this.getDefaultAuthServerForFlow(this.selectedFlow),
      });
    }
  }

  async setClaimFormFields(credentialConfigIds: string[]) {
    // Clean up existing form controls that are no longer selected
    const claimsGroup = this.configStepForm.get('claims') as FormGroup;
    const existingIds = Object.keys(claimsGroup.controls);

    for (const existingId of existingIds) {
      if (!credentialConfigIds.includes(existingId)) {
        claimsGroup.removeControl(existingId);
      }
    }

    // Update IAE status tracking for selected configs
    this.selectedConfigsIaeStatus.clear();
    for (const id of credentialConfigIds) {
      const config = this.credentialConfigs.find((cred) => cred.id === id);
      const hasIae = (config?.iaeActions?.length || 0) > 0;
      this.selectedConfigsIaeStatus.set(id, hasIae);
    }

    // Initialize webhook forms for external AS flow
    // Clean up removed configs
    for (const existingId of this.externalAsWebhooks.keys()) {
      if (!credentialConfigIds.includes(existingId)) {
        this.externalAsWebhooks.delete(existingId);
      }
    }
    // Add webhook forms for new configs
    for (const id of credentialConfigIds) {
      if (!this.externalAsWebhooks.has(id)) {
        const config = this.credentialConfigs.find((cred) => cred.id === id);
        const configuredProviderId = config?.attributeProviderId || '';
        const attributeProviderId =
          configuredProviderId ||
          (this.availableAttributeProviders.length === 1
            ? this.availableAttributeProviders[0].id
            : '');
        const apGroup = new FormGroup({
          attributeProviderId: new FormControl(attributeProviderId),
        });
        this.externalAsWebhooks.set(id, apGroup);
      }
    }

    this.elements = [];
    this.fields = [];

    for (const id of credentialConfigIds) {
      const config = this.credentialConfigs.find((cred) => cred.id === id);
      const runtime = config?.fields?.length ? deriveRuntimeArtifacts(config.fields as any) : null;
      const schemaForForm =
        config && runtime?.schema ? this.getSchemaForForm(config, runtime.schema as any) : null;

      // Schema is always assumed to be available (form input is always possible)
      // attributeProviderId is optional (attribute provider input is only available if configured)
      // claims are optional default values to pre-fill the form

      // Default to form input (schema is always available)
      const defaultSource = 'form';

      // Generate form fields from schema (only needed for pre-auth flow)
      if (schemaForForm) {
        const baseConfig = this.formlyJsonschema.toFieldConfig(schemaForForm as any, {
          map: (field) => this.addClaimNameLabel(field),
        });
        this.fields.push(this.addGroupHeaders(baseConfig));
      } else {
        this.fields.push({} as any); // Empty field config as fallback
      }

      this.elements.push({
        id,
        defaultClaims: this.normalizeClaimsForForm(config, runtime?.claims),
        attributeProviderId: config!.attributeProviderId || undefined, // Optional attribute provider reference
        claimSource: defaultSource,
      });

      // Only add form control if source is 'form' (not webhook) and it doesn't exist yet
      if (defaultSource === 'form' && !claimsGroup.contains(id)) {
        claimsGroup.addControl(id, new UntypedFormGroup({}));
      }
    }
    // Trigger change detection after modifications
    this.cdr.detectChanges();
  }

  /**
   * Updates the claim source for a specific credential configuration
   */
  onClaimSourceChange(elementId: string, source: string) {
    const element = this.elements.find((e) => e.id === elementId);
    if (element) {
      element.claimSource = source;

      const claimsGroup = this.configStepForm.get('claims') as FormGroup;

      if (source === 'attributeProvider') {
        // Remove form control when switching to attribute provider
        if (claimsGroup.contains(elementId)) {
          claimsGroup.removeControl(elementId);
        }
        // Add form control when switching to form
      } else if (!claimsGroup.contains(elementId)) {
        claimsGroup.addControl(elementId, new UntypedFormGroup({}));
      }
    }
  }

  get allAuthorizationServerOptions(): { value: string; label: string }[] {
    return this.authCodeAuthorizationServerOptions;
  }

  get preAuthAuthorizationServerOptions(): { value: string; label: string }[] {
    return this.getAuthorizationServerOptions('pre_authorized_code');
  }

  get authCodeAuthorizationServerOptions(): { value: string; label: string }[] {
    return this.getAuthorizationServerOptions('authorization_code');
  }

  private getAuthorizationServerOptions(
    flow: 'authorization_code' | 'pre_authorized_code'
  ): { value: string; label: string }[] {
    const servers = ((this.issuanceConfig as any)?.authorizationServers ?? []) as any[];

    return servers
      .filter((server) => server?.enabled !== false)
      .filter((server) => flow !== 'authorization_code' || server?.type !== 'built-in')
      .map((server) => {
        if (server?.type === 'external' && typeof server?.issuer === 'string') {
          return {
            value: server.id,
            label: server.label || server.id,
          };
        }

        if (server?.type === 'oid4vp' && server?.id) {
          return {
            value: server.id,
            label: server.label || server.id,
          };
        }

        if (server?.type === 'chained' && server?.id) {
          return {
            value: server.id,
            label: server.label || 'Chained Authorization Server',
          };
        }

        if (server?.type === 'built-in' && server?.id) {
          return {
            value: server.id,
            label: server.label || server.id,
          };
        }

        return undefined;
      })
      .filter((option): option is { value: string; label: string } => !!option);
  }

  get authCodeAuthorizationServerGroups(): {
    label: string;
    options: { value: string; label: string }[];
  }[] {
    const options = this.authCodeAuthorizationServerOptions;
    if (options.length === 0) {
      return [];
    }

    return [
      {
        label: 'Configured Authorization Servers (in priority order)',
        options,
      },
    ];
  }

  /**
   * Returns the first configured authorization server for auth-code flow.
   */
  private getDefaultAuthServerForFlow(flow: string): string {
    let options: { value: string; label: string }[] = [];
    if (flow === 'authorization_code_external') {
      options = this.authCodeAuthorizationServerOptions;
    } else if (flow === 'pre_authorized_code') {
      options = this.preAuthAuthorizationServerOptions;
    }

    if (options.length === 0) {
      return '';
    }

    return options[0]?.value || '';
  }

  private syncAuthorizationServerControl(flow: string): void {
    const control = this.configStepForm.get('authorization_server');
    const options = this.getAuthorizationServerOptions(
      flow as 'authorization_code' | 'pre_authorized_code'
    );
    const selected = control?.value;

    if (options.length === 1) {
      control?.setValue(options[0].value, { emitEvent: false });
      control?.clearValidators();
    } else if (options.length > 1) {
      if (!options.some((option) => option.value === selected)) {
        control?.setValue('', { emitEvent: false });
      }
      control?.setValidators(Validators.required);
    } else {
      control?.setValue('', { emitEvent: false });
      control?.clearValidators();
    }

    control?.updateValueAndValidity({ emitEvent: false });
  }

  isSelectedAuthorizationServerChained(): boolean {
    const selectedAuthorizationServerId = this.configStepForm.get('authorization_server')?.value;
    if (!selectedAuthorizationServerId) {
      return false;
    }

    const servers = ((this.issuanceConfig as any)?.authorizationServers ?? []) as any[];
    const selectedServer = servers.find((server) => server?.id === selectedAuthorizationServerId);
    return selectedServer?.type === 'chained';
  }

  getForm(id: string) {
    return this.configStepForm.get(`claims.${id}`) as UntypedFormGroup;
  }

  getFields(arg0: FormlyFieldConfig<FormlyFieldProps & Record<string, any>>) {
    return [arg0];
  }

  private formatGroupLabel(field: FormlyFieldConfig): string {
    const props = (field.props ?? {}) as Record<string, any>;
    const explicit = props['label'] || props['title'];
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      return explicit;
    }

    const key = Array.isArray(field.key) ? field.key.at(-1) : field.key;
    const raw = key == null ? '' : String(key);

    return raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  /**
   * The derived schema only has a title for claims with display labels. Fall back
   * to the claim name so every input has a visible label and an accessible name.
   * Objects and arrays get their header from addGroupHeaders instead.
   */
  private addClaimNameLabel(field: FormlyFieldConfig): FormlyFieldConfig {
    const isLeaf = !field.fieldGroup && !field.fieldArray;
    const key = Array.isArray(field.key) ? field.key.at(-1) : field.key;
    if (isLeaf && key != null && !field.props?.label) {
      field.props ??= {};
      field.props.label = String(key);
    }
    return field;
  }

  private addGroupHeaders(field: FormlyFieldConfig, level = 0): FormlyFieldConfig {
    const group = field.fieldGroup?.map((child) => this.addGroupHeaders(child, level + 1));
    const updated: FormlyFieldConfig = {
      ...field,
      fieldGroup: group,
    };

    const hasChildren = Array.isArray(updated.fieldGroup) && updated.fieldGroup.length > 0;
    const hasKey = updated.key !== undefined && updated.key !== null;
    const type = typeof updated.type === 'string' ? updated.type : '';
    const isContainer = type === 'object' || type === 'array' || hasChildren;

    if (!hasChildren || !hasKey || !isContainer) {
      return updated;
    }

    const label = this.formatGroupLabel(updated);
    if (!label) {
      return updated;
    }

    const safeLabel = this.escapeHtml(label);
    const nextLevel = Math.min(level + 1, 3);

    return {
      ...updated,
      className: [updated.className, `claim-group claim-group-level-${nextLevel}`]
        .filter(Boolean)
        .join(' '),
      fieldGroup: [
        {
          type: 'template',
          template: `<div class="claim-group-header claim-group-header-level-${nextLevel}">${safeLabel}</div>`,
        },
        ...(updated.fieldGroup || []),
      ],
    };
  }

  private isMdocConfig(config: CredentialConfig | undefined): boolean {
    return config?.config?.format === 'mso_mdoc';
  }

  private getMdocNamespace(config: CredentialConfig | undefined): string | undefined {
    if (!this.isMdocConfig(config)) {
      return undefined;
    }

    const firstField = config?.fields?.find(
      (field) => Array.isArray(field.path) && field.path.length > 0
    );
    return firstField?.path?.[0] ? String(firstField.path[0]) : undefined;
  }

  private getSchemaForForm(
    config: CredentialConfig,
    schema: Record<string, any>
  ): Record<string, any> {
    const namespace = this.getMdocNamespace(config);
    const propertyNames = Object.keys(schema?.['properties'] ?? {});

    if (
      namespace &&
      schema?.['type'] === 'object' &&
      propertyNames.length === 1 &&
      propertyNames[0] === namespace
    ) {
      const namespaceSchema = schema['properties']?.[namespace];
      if (
        namespaceSchema &&
        typeof namespaceSchema === 'object' &&
        !Array.isArray(namespaceSchema)
      ) {
        return namespaceSchema;
      }
    }

    return schema;
  }

  private normalizeClaimsForForm(config: CredentialConfig | undefined, claims: unknown): unknown {
    const namespace = this.getMdocNamespace(config);
    if (!namespace || !claims || typeof claims !== 'object' || Array.isArray(claims)) {
      return claims;
    }

    const namespacedClaims = claims as Record<string, unknown>;
    const nestedClaims = namespacedClaims[namespace];
    if (nestedClaims && typeof nestedClaims === 'object' && !Array.isArray(nestedClaims)) {
      return nestedClaims;
    }

    return claims;
  }

  private normalizeClaimsForSubmission(
    config: CredentialConfig | undefined,
    claims: unknown
  ): unknown {
    const namespace = this.getMdocNamespace(config);
    if (!namespace || !claims || typeof claims !== 'object' || Array.isArray(claims)) {
      return claims;
    }

    const claimObject = claims as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(claimObject, namespace)) {
      return claims;
    }

    return {
      [namespace]: claims,
    };
  }

  async onSubmit(): Promise<void> {
    // Validate all step forms
    this.syncAuthorizationServerControl(this.selectedFlow);
    if (
      this.flowStepForm.invalid ||
      this.credentialStepForm.invalid ||
      this.configStepForm.invalid
    ) {
      this.flowStepForm.markAllAsTouched();
      this.credentialStepForm.markAllAsTouched();
      this.configStepForm.markAllAsTouched();
      return;
    }

    this.generatingOffer = true;

    try {
      const flowSelection = this.flowStepForm.get('flow')?.value;
      const credentialConfigurationIds = this.credentialStepForm.get(
        'credentialConfigurationIds'
      )?.value;
      const configValue = this.configStepForm.value;

      // Map flow selection to actual flow type
      const flow =
        flowSelection === 'pre_authorized_code' ? 'pre_authorized_code' : 'authorization_code';

      // Build credentialClaims for pre-authorized code flow and external AS flow
      let credentialClaims: any = undefined;
      if (flowSelection === 'pre_authorized_code') {
        credentialClaims = {};
        for (const element of this.elements) {
          const config = this.credentialConfigs.find((cred) => cred.id === element.id);
          if (element.claimSource === 'form') {
            credentialClaims[element.id] = {
              type: 'inline',
              claims: this.normalizeClaimsForSubmission(config, configValue.claims[element.id]),
            };
          } else if (element.claimSource === 'attributeProvider') {
            credentialClaims[element.id] = {
              type: 'attributeProvider',
              attributeProviderId: element.attributeProviderId,
            };
          }
        }
      } else if (
        flowSelection === 'authorization_code_external' ||
        flowSelection === 'authorization_code_iae'
      ) {
        // For external AS and IAE flows, include attribute provider reference for each credential (if configured)
        credentialClaims = {};
        for (const configId of credentialConfigurationIds) {
          const webhookForm = this.externalAsWebhooks.get(configId);
          const apId = webhookForm?.get('attributeProviderId')?.value;
          if (apId) {
            credentialClaims[configId] = {
              type: 'attributeProvider',
              attributeProviderId: apId,
            };
          }
        }
      }

      const authorizationServer =
        flowSelection === 'authorization_code_external' || flowSelection === 'pre_authorized_code'
          ? configValue.authorization_server || undefined
          : undefined;

      const offerRequest: OfferRequestDto = {
        flow: flow || 'pre_authorized_code',
        response_type: 'uri',
        credentialConfigurationIds,
        credentialClaims:
          credentialClaims && Object.keys(credentialClaims).length > 0
            ? credentialClaims
            : undefined,
        ...(flowSelection === 'pre_authorized_code' && configValue.tx_code
          ? {
              tx_code: configValue.tx_code,
              ...(configValue.tx_code_description
                ? { tx_code_description: configValue.tx_code_description }
                : {}),
            }
          : {}),
        ...(authorizationServer ? { authorization_server: authorizationServer } : {}),
      };

      const result = await this.issuanceConfigService.getOffer(offerRequest);
      const offerResult = result || null;

      this.snackBar.open(
        'Offer generated successfully! Redirecting to session details...',
        'Close',
        {
          duration: 2000,
          panelClass: ['success-snackbar'],
        }
      );

      // Redirect to session details page with QR code and polling enabled
      this.router.navigate(['/session-management', offerResult!.session]);
    } catch (error: unknown) {
      this.snackBar.open(getApiErrorMessage(error, 'Failed to generate offer'), 'Close', {
        duration: 3000,
        panelClass: ['error-snackbar'],
      });
    } finally {
      this.generatingOffer = false;
    }
  }

  addPreConfigured(form: any) {
    this.configStepForm.get('claims')?.patchValue({ [form.id]: form.defaultClaims });
  }

  importClaims() {
    const currentConfig = this.configStepForm.get('claims')?.value;

    const key = Object.keys(currentConfig)[0];

    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Complete Configuration JSON',
        jsonData: Object.values(currentConfig)[0],
        readonly: false,
      },
      disableClose: true,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.configStepForm.get('claims')?.patchValue({ [key]: result });
      }
    });
  }

  resetForm(): void {
    this.flowStepForm.reset({ flow: 'pre_authorized_code' });
    this.credentialStepForm.reset({ credentialConfigurationIds: [] });
    this.configStepForm.reset({ tx_code: '', authorization_server: '' });
    this.elements = [];
    this.fields = [];
    this.selectedConfigsIaeStatus.clear();
    if (this.stepper) {
      this.stepper.reset();
    }
  }

  /**
   * Pre-fill the form from an existing offer request (recreate offer flow).
   * This method is called before valueChanges subscriptions are set up,
   * so we need to manually trigger form field setup.
   */
  private async prefillFromOffer(offer: OfferRequestDto): Promise<void> {
    // Configs are already loaded in ngOnInit before this is called

    // Determine the correct flow type for the form
    // The stored offer only has 'authorization_code' or 'pre_authorized_code',
    // but the form distinguishes between 'authorization_code_external' and 'authorization_code_iae'
    let formFlow: string = offer.flow || 'pre_authorized_code';
    if (offer.flow === 'authorization_code') {
      // Check if any selected credential configs have IAE configured
      const hasIae = offer.credentialConfigurationIds?.some((id) => {
        const config = this.credentialConfigs.find((c) => c.id === id);
        return (config?.iaeActions?.length || 0) > 0;
      });

      // If configs have IAE and no external AS was specified, it was an IAE flow
      // If an external AS was specified, it was an external AS flow
      if (hasIae && !offer.authorization_server) {
        formFlow = 'authorization_code_iae';
      } else {
        formFlow = 'authorization_code_external';
      }
    }

    // Set flow (triggers no subscription since we haven't set them up yet)
    this.flowStepForm.patchValue({
      flow: formFlow,
    });

    // Set credential configuration IDs
    this.credentialStepForm.patchValue({
      credentialConfigurationIds: offer.credentialConfigurationIds || [],
    });

    // Manually set up claim form fields (normally done by valueChanges subscription)
    await this.setClaimFormFields(offer.credentialConfigurationIds || []);

    // Set config step values
    this.configStepForm.patchValue({
      tx_code: offer.tx_code || '',
      tx_code_description: offer.tx_code_description || '',
      authorization_server:
        offer.authorization_server || this.getDefaultAuthServerForFlow(formFlow),
    });
    this.syncAuthorizationServerControl(formFlow);

    // Pre-fill claims for pre-auth flow
    if (offer.credentialClaims && formFlow === 'pre_authorized_code') {
      for (const [credId, claimData] of Object.entries(offer.credentialClaims)) {
        const element = this.elements.find((e) => e.id === credId);
        if (element && claimData && typeof claimData === 'object') {
          if ('type' in claimData && claimData.type === 'inline' && 'claims' in claimData) {
            element.claimSource = 'form';
            const config = this.credentialConfigs.find((cred) => cred.id === credId);
            this.configStepForm.get('claims')?.patchValue({
              [credId]: this.normalizeClaimsForForm(config, claimData.claims),
            });
          } else if ('type' in claimData && claimData.type === 'attributeProvider') {
            element.claimSource = 'attributeProvider';
          }
        }
      }
    }

    // Pre-fill attribute provider for auth code flows
    if (
      offer.credentialClaims &&
      (formFlow === 'authorization_code_external' || formFlow === 'authorization_code_iae')
    ) {
      for (const [credId, claimData] of Object.entries(offer.credentialClaims)) {
        if (
          claimData &&
          typeof claimData === 'object' &&
          'type' in claimData &&
          claimData.type === 'attributeProvider' &&
          'attributeProviderId' in claimData
        ) {
          const webhookForm = this.externalAsWebhooks.get(credId);
          if (webhookForm) {
            webhookForm.patchValue({
              attributeProviderId: claimData.attributeProviderId,
            });
          }
        }
      }
    }

    this.cdr.detectChanges();

    // Jump stepper to the last step — by the time prefillFromOffer runs
    // (after awaiting data loads), the view is already initialized
    if (this.stepper) {
      this.stepper.steps.forEach((step, index) => {
        if (index < this.stepper.steps.length - 1) {
          step.completed = true;
          step.interacted = true;
        }
      });
      this.stepper.selectedIndex = this.stepper.steps.length - 1;
      this.cdr.detectChanges();
    }

    this.snackBar.open('Form pre-filled from previous offer', 'Close', { duration: 2000 });
  }
}
