import { CommonModule } from '@angular/common';
import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ElementRef,
  HostListener,
  Injector,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import {
  type AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  FormGroupDirective,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { ErrorStateMatcher } from '@angular/material/core';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatRadioModule } from '@angular/material/radio';
import { MatExpansionModule, MatExpansionPanel } from '@angular/material/expansion';
import { MatDividerModule } from '@angular/material/divider';
import { ActivatedRoute, type Params, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  keyChainControllerGetAll,
  trustListControllerCreateTrustList,
  trustListControllerGetTrustList,
  trustListControllerUpdateTrustList,
  type KeyChainResponseDto,
  type TrustList,
} from '@eudiplo/sdk-core';
import { EditorComponent } from '../../utils/editor/editor.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { fieldErrorMessage, showIssuesAtFields } from '../../utils/form-errors';
import { focusAfterRenderIfLost, focusRowAfterRemoval } from '../../common/focus-if-lost.util';
import {
  fieldsToFixMessage,
  focusFieldToFix,
  sectionsWithErrors,
} from '../../common/field-to-fix.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { fromFormQueryParams } from '../../common/return-to-form';

/** Common info fields for both internal and external entities */
interface EntityInfoForm {
  providerType: FormControl<'attestation-provider' | 'wallet-provider'>;
  infoName: FormControl<string>;
  infoLang: FormControl<string>;
  infoUri: FormControl<string>;
  infoCountry: FormControl<string>;
  infoLocality: FormControl<string>;
  infoPostalCode: FormControl<string>;
  infoStreetAddress: FormControl<string>;
  infoContactUri: FormControl<string>;
}

interface InternalEntityForm extends EntityInfoForm {
  type: FormControl<'internal'>;
  issuerKeyChainId: FormControl<string>;
  revocationKeyChainId: FormControl<string>;
}

interface ExternalEntityForm extends EntityInfoForm {
  type: FormControl<'external'>;
  issuerCertPem: FormControl<string>;
  revocationCertPem: FormControl<string>;
}

/**
 * The key chain selects of this page, by the usage type they are for: an entity's issuer
 * (`attestation`) and revocation (`statusList`) key chain, and the trust list's own (`trustList`).
 */
type TrustListKeyChainUsage = 'attestation' | 'statusList' | 'trustList';

/** How hints and options name the key chains a select accepts, in the words of Key Management. */
const KEY_CHAIN_USAGE_NAMES: Record<TrustListKeyChainUsage, string> = {
  attestation: 'credential signing',
  statusList: 'status list or credential signing',
  trustList: 'trust list',
};

/** How a create link names the usage type of the key chain it creates for a select of a usage. */
const CREATED_KEY_CHAIN_NAMES: Record<TrustListKeyChainUsage, string> = {
  attestation: 'credential signing',
  statusList: 'status list',
  trustList: 'trust list',
};

@Component({
  selector: 'app-trust-list-edit',
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatRadioModule,
    MatExpansionModule,
    MatDividerModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
    EditorComponent,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './trust-list-edit.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './trust-list-edit.component.scss',
})
export class TrustListEditComponent implements OnInit {
  trustListId?: string | null;
  trustList?: TrustList;
  form!: FormGroup;
  /** While the trust list to edit is requested; the form waits for it. */
  loading = false;
  /** Set when the trust list to edit could not be loaded, so no empty form is shown. */
  loadError = '';
  /** While a save runs, so a second click does not send it again. */
  saving = false;
  /** Entities with a field the backend rejected; their panels open and stay open. */
  readonly rejectedEntities = new Set<AbstractControl>();

  /** Available key chains for selection */
  availableKeyChains: KeyChainResponseDto[] = [];
  /** Key chains filtered by usage type */
  attestationKeyChains: KeyChainResponseDto[] = [];
  statusListKeyChains: KeyChainResponseDto[] = [];
  trustListKeyChains: KeyChainResponseDto[] = [];
  /**
   * The option groups of the Revocation Key Chain select. The backend accepts a status list key
   * chain there, or a credential signing one, which signs the status lists that are pinned to it,
   * and all of them when the tenant has no status list key chain. Status list key chains come
   * first, so the usual choice stays the first one.
   */
  revocationGroups: { label: string; keyChains: KeyChainResponseDto[] }[] = [];
  /** The key chains of `revocationGroups`, in their order. */
  private revocationKeyChains: KeyChainResponseDto[] = [];
  /** While the key chains are requested, so a second Retry does not send it again. */
  loadingKeyChains = false;
  /** Set when the key chains could not be loaded; the key chain selects say so and offer a retry. */
  keyChainsLoadError = '';
  /** Set once the key chains have loaded, so an empty list means the tenant has none of its kind. */
  private keyChainsLoaded = false;
  /** The usages of the signing key chain select, and of an internal entity's key chain selects. */
  readonly signingKeyChainUsages: readonly TrustListKeyChainUsage[] = ['trustList'];
  readonly entityKeyChainUsages: readonly TrustListKeyChainUsage[] = ['attestation', 'statusList'];
  /**
   * Query parameters of the create links per usage: the key wizard preselects the usage and, once
   * the key chain exists, says to return to this tab instead of leaving it.
   */
  private readonly keyChainLinkParams: Readonly<Record<TrustListKeyChainUsage, Params>> = {
    attestation: fromFormQueryParams({ usage: 'attestation' }),
    statusList: fromFormQueryParams({ usage: 'statusList' }),
    trustList: fromFormQueryParams({ usage: 'trustList' }),
  };

  /**
   * Whether the key chain lists say what the tenant has: they loaded, and the last load did not
   * fail. After a failed reload the lists are stale, so nothing is said about missing key chains.
   */
  private get keyChainsKnown(): boolean {
    return this.keyChainsLoaded && !this.keyChainsLoadError;
  }
  /** The key chain selects whose create link the user followed; their key chains reload on return. */
  private creatingKeyChainFor?: HTMLElement;

  private readonly editorOptionsPem = {
    automaticLayout: true,
    language: 'pem',
    minimap: { enabled: false },
    ariaRequired: true,
  };
  /** Each certificate editor names its certificate, which its visible label does not do for it. */
  readonly issuerCertEditorOptions = {
    ...this.editorOptionsPem,
    ariaLabel: 'Issuer certificate (PEM)',
  };
  readonly revocationCertEditorOptions = {
    ...this.editorOptionsPem,
    ariaLabel: 'Revocation certificate (PEM)',
  };

  // Where focus goes when the entity holding it is removed, in the order of the entities.
  @ViewChildren('entityHeader', { read: ElementRef })
  private readonly entityHeaders?: QueryList<ElementRef<HTMLElement>>;
  @ViewChild('addEntityButton', { read: ElementRef })
  private readonly addEntityButton?: ElementRef<HTMLElement>;
  @ViewChildren(MatExpansionPanel) private readonly entityPanels?: QueryList<MatExpansionPanel>;
  @ViewChild('trustListForm', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  @ViewChild(FormGroupDirective) private readonly formDirective?: FormGroupDirective;
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar,
    private readonly injector: Injector,
    private readonly errorStateMatcher: ErrorStateMatcher
  ) {}

  ngOnInit() {
    this.trustListId = this.route.snapshot.paramMap.get('id');

    this.form = new FormGroup({
      id: new FormControl('', { validators: [Validators.required] }),
      description: new FormControl(''),
      keyChainId: new FormControl('', {
        validators: (control) => this.signingKeyChainError(control),
      }),
      entities: new FormArray([]),
    });

    void this.loadKeyChains();

    if (this.trustListId) {
      void this.load();
    }
  }

  get entitiesArray(): FormArray {
    return this.form.get('entities') as FormArray;
  }

  get isEditMode(): boolean {
    return !!this.trustListId;
  }

  private async loadKeyChains(): Promise<void> {
    this.loadingKeyChains = true;
    try {
      const response = await keyChainControllerGetAll({});
      this.availableKeyChains = response.data ?? [];

      // Filter key chains by usage type
      this.attestationKeyChains = this.availableKeyChains.filter(
        (kc) => kc.usageType === 'attestation'
      );
      this.statusListKeyChains = this.availableKeyChains.filter(
        (kc) => kc.usageType === 'statusList'
      );
      this.trustListKeyChains = this.availableKeyChains.filter(
        (kc) => kc.usageType === 'trustList'
      );
      this.revocationGroups = [
        { label: 'Status list key chains', keyChains: this.statusListKeyChains },
        {
          label: this.statusListKeyChains.length
            ? 'Credential signing key chains (for status lists pinned to them)'
            : 'Credential signing key chains',
          keyChains: this.attestationKeyChains,
        },
      ].filter((group) => group.keyChains.length > 0);
      this.revocationKeyChains = this.revocationGroups.flatMap((group) => group.keyChains);
      this.keyChainsLoadError = '';
      this.keyChainsLoaded = true;
    } catch (error) {
      console.error('Failed to load key chains:', error);
      this.keyChainsLoadError = getApiErrorMessage(error, 'Failed to load key chains');
      openErrorSnackBar(this.snackBar, this.keyChainsLoadError);
    } finally {
      this.loadingKeyChains = false;
    }
    this.revalidateSigningKeyChain();
  }

  /**
   * Validates the signing key chain again once the key chains or the stored trust list arrive,
   * since whether saving with it fails depends on both. The select looks filled in even then, so it
   * shows its error at once instead of waiting to be touched. An issue the backend put at the field
   * stays until the field is edited.
   */
  private revalidateSigningKeyChain(): void {
    const signing = this.form.get('keyChainId');
    if (!signing) return;
    const server: unknown = signing.getError('server');
    signing.updateValueAndValidity();
    if (typeof server === 'string') signing.setErrors({ ...signing.errors, server });
    if (signing.invalid) signing.markAsTouched();
  }

  /**
   * Loads the key chains again, keeping what the user entered. When a success removes the Retry or
   * Reload button, focus moves to the first select in `fields`, the key chain selects it was next
   * to; a reload that still finds a usage without key chains keeps the button, and the focus on it.
   */
  async retryKeyChains(fields: HTMLElement): Promise<void> {
    if (this.loadingKeyChains) return;
    await this.loadKeyChains();
    if (!this.keyChainsLoadError) {
      focusAfterRenderIfLost(
        this.injector,
        () => fields.querySelector<HTMLElement>('mat-select') ?? undefined
      );
    }
  }

  /** A create link opened the key chain wizard in a new tab, next to the selects in `fields`. */
  openKeyChainCreation(fields: HTMLElement): void {
    this.creatingKeyChainFor = fields;
  }

  /** After creating a key chain in another tab, the user comes back to this one. */
  @HostListener('window:focus')
  onWindowFocus(): void {
    const fields = this.creatingKeyChainFor;
    if (!fields) return;
    this.creatingKeyChainFor = undefined;
    void this.retryKeyChains(fields);
  }

  /** How an option names a key chain. */
  keyChainLabel(keyChain: KeyChainResponseDto): string {
    return keyChain.description ? `${keyChain.description} (${keyChain.id})` : keyChain.id;
  }

  /** The key chains a select for `usage` offers. */
  private keyChainsOf(usage: TrustListKeyChainUsage): KeyChainResponseDto[] {
    switch (usage) {
      case 'attestation':
        return this.attestationKeyChains;
      case 'statusList':
        return this.revocationKeyChains;
      case 'trustList':
        return this.trustListKeyChains;
    }
  }

  /**
   * The selected key chain when it is not among the options for `usage`, so its select shows the
   * stored ID instead of looking empty. While the key chains are known, its label says why it is
   * not listed: another usage type, or it does not exist. Undefined when it is listed.
   */
  unlistedKeyChain(
    value: unknown,
    usage: TrustListKeyChainUsage
  ): { id: string; label: string } | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    if (this.keyChainsOf(usage).some((keyChain) => keyChain.id === value)) return undefined;
    switch (this.unlistedReason(value, usage)) {
      case 'otherUsage':
        return { id: value, label: `${value} (not a ${KEY_CHAIN_USAGE_NAMES[usage]} key chain)` };
      case 'missing':
        return { id: value, label: `${value} (does not exist)` };
      default:
        // Until the key chains have loaded, or after a failed reload, nothing is known about it.
        return { id: value, label: value };
    }
  }

  /**
   * Why the loaded key chains do not offer `value` for `usage`: it has another usage type, or it
   * does not exist. Undefined when it is offered, empty, or the key chains are not known.
   */
  private unlistedReason(
    value: unknown,
    usage: TrustListKeyChainUsage
  ): 'otherUsage' | 'missing' | undefined {
    if (!this.keyChainsKnown || typeof value !== 'string' || !value) return undefined;
    if (this.keyChainsOf(usage).some((keyChain) => keyChain.id === value)) return undefined;
    return this.availableKeyChains.some((keyChain) => keyChain.id === value)
      ? 'otherUsage'
      : 'missing';
  }

  /**
   * What saving does with a key chain that an entity's select for `usage` holds but does not offer;
   * '' otherwise. The signing key chain select has {@link signingKeyChainProblem}.
   */
  private unlistedKeyChainWarning(
    value: unknown,
    usage: Exclude<TrustListKeyChainUsage, 'trustList'>
  ): string {
    switch (this.unlistedReason(value, usage)) {
      case 'missing':
        return missingKeyChainMessage('This key chain');
      case 'otherUsage':
        // An entity's key chain of another usage type is accepted when the stored list already
        // names it there, which is the only way the form holds one, since its selects offer only
        // accepted usage types.
        return `This is not a ${KEY_CHAIN_USAGE_NAMES[usage]} key chain; saving still puts its certificate in the trust list. Choose another.`;
      default:
        return '';
    }
  }

  /**
   * Whether an internal entity selects a key chain that is of another usage type or does not
   * exist, as its header says, since its panel may be collapsed.
   */
  entityKeyChainsToCheck(entity: AbstractControl): boolean {
    return (
      this.unlistedReason(entity.get('issuerKeyChainId')?.value, 'attestation') !== undefined ||
      this.unlistedReason(entity.get('revocationKeyChainId')?.value, 'statusList') !== undefined
    );
  }

  /**
   * For the revocation select holding `value`: when a credential signing key chain signs the
   * status lists, as the select offers them too; '' when it holds none or the key chains are not
   * known.
   */
  private credentialSigningRevocationHint(value: unknown): string {
    if (!this.keyChainsKnown || !this.attestationKeyChains.length) return '';
    if (!this.statusListKeyChains.length) {
      return 'No status list key chains, so a credential signing key chain signs the status lists.';
    }
    return this.attestationKeyChains.some((keyChain) => keyChain.id === value)
      ? 'A credential signing key chain signs only the status lists pinned to it; the others are signed by a status list key chain.'
      : '';
  }

  /** Whether the key chains are known and none of them has `usage`. */
  noKeyChains(usage: TrustListKeyChainUsage): boolean {
    return this.keyChainsKnown && this.keyChainsOf(usage).length === 0;
  }

  /** The query parameters of the create link for a select of `usage`, the same object each time. */
  keyChainLinkParamsOf(usage: TrustListKeyChainUsage): Params {
    return this.keyChainLinkParams[usage];
  }

  /** How the create link for a select of `usage` names the key chain it creates. */
  createdKeyChainName(usage: TrustListKeyChainUsage): string {
    return CREATED_KEY_CHAIN_NAMES[usage];
  }

  /**
   * The empty option of the signing key chain select, which leaves `keyChainId` out: a create
   * then signs with a trust list key chain of the tenant, and fails without one; an update keeps
   * the stored key chain.
   */
  get defaultSigningKeyChainLabel(): string {
    return this.isEditMode
      ? 'Keep the current key chain'
      : 'Any trust list key chain of the tenant';
  }

  /**
   * Why saving fails with `value` in the signing key chain select, as far as the loaded key chains
   * tell; '' when it does not, or nothing is known. The key chain that would sign is the selected
   * one or, when the empty option keeps it on edit, the current one. The backend refuses one that
   * is gone or lacks trust list usage, and a create without one while the tenant has no trust list
   * key chain to look up.
   */
  signingKeyChainProblem(value: unknown): string {
    const kept = !value && this.isEditMode;
    // Until the trust list has loaded, nothing is known about the key chain it keeps.
    if (kept && !this.trustList) return '';
    const keyChainId = value || (kept ? this.trustList?.keyChainId : '');
    const reason = this.unlistedReason(keyChainId, 'trustList');
    if (reason === 'missing') {
      return missingKeyChainMessage(kept ? 'The current key chain' : 'This key chain');
    }
    if (reason === 'otherUsage') {
      return `${kept ? 'The current key chain' : 'This'} is not a trust list key chain, so saving fails. Choose another.`;
    }
    return !keyChainId && this.noKeyChains('trustList') ? this.noKeyChainsMessage('trustList') : '';
  }

  /** The signing key chain is invalid while saving with it fails, so the form says why first. */
  private signingKeyChainError(control: AbstractControl): ValidationErrors | null {
    return this.signingKeyChainProblem(control.value) ? { signingKeyChain: true } : null;
  }

  /** Whether key chain selects of `usages` need a retry, or a key chain created first. */
  keyChainActionsNeeded(usages: readonly TrustListKeyChainUsage[]): boolean {
    return this.keyChainsLoadError !== '' || usages.some((usage) => this.noKeyChains(usage));
  }

  /** Why a select for `usage` has no options, and where to create one. */
  private noKeyChainsMessage(usage: TrustListKeyChainUsage): string {
    return `No ${KEY_CHAIN_USAGE_NAMES[usage]} key chains. Create one in Key Management.`;
  }

  /**
   * The hint of the key chain select for `usage` holding `value`: `hint`, unless the key chains
   * are loading or failed to load, saving with `value` fails or the select does not offer it, no
   * key chain has that usage, or a credential signing key chain may sign the revocation's status
   * lists.
   */
  keyChainHint(hint: string, value: unknown, usage: TrustListKeyChainUsage): string {
    if (this.loadingKeyChains) return 'Loading key chains…';
    if (this.keyChainsLoadError) return 'Could not load key chains.';
    const warning =
      usage === 'trustList'
        ? this.signingKeyChainProblem(value)
        : this.unlistedKeyChainWarning(value, usage);
    if (warning) return warning;
    if (this.noKeyChains(usage)) return this.noKeyChainsMessage(usage);
    const credentialSigning =
      usage === 'statusList' ? this.credentialSigningRevocationHint(value) : '';
    return credentialSigning || hint;
  }

  /**
   * Under an empty key chain select of `usage` that must not stay empty, which replaces its hint:
   * why it may be empty.
   */
  keyChainRequiredMessage(usage: TrustListKeyChainUsage): string {
    if (this.keyChainsLoadError) return 'The key chains could not be loaded.';
    return this.noKeyChains(usage) ? this.noKeyChainsMessage(usage) : 'Select a key chain.';
  }

  /** Loads the trust list to edit; on failure the form stays hidden behind a retry. */
  async load(): Promise<void> {
    if (!this.trustListId) return;
    const retrying = this.loadError !== '';
    this.loading = true;
    this.loadError = '';
    // The form needs the key chains too; a retry of the page also retries them if they failed.
    if (retrying && this.keyChainsLoadError && !this.loadingKeyChains) void this.loadKeyChains();

    try {
      const response = await trustListControllerGetTrustList({
        path: { id: this.trustListId },
      });

      this.trustList = response.data;
      // A defence: the form shows only after a successful load, so it holds no entities yet;
      // should it ever load twice, the stored entities replace the form's, never add to them.
      this.entitiesArray.clear();

      this.form.patchValue({
        id: this.trustList.id || this.trustListId,
        description: this.trustList.description || '',
        keyChainId: this.trustList.keyChainId || '',
      });

      // Load entities from stored entityConfig if available, otherwise parse from data
      if (this.trustList.entityConfig && Array.isArray(this.trustList.entityConfig)) {
        this.loadEntitiesFromConfig(this.trustList.entityConfig);
      } else if (this.trustList.data) {
        this.loadEntitiesFromData(this.trustList.data);
      }
      this.revalidateSigningKeyChain();
    } catch (error) {
      console.error('Failed to load trust list:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load trust list');
    } finally {
      this.loading = false;
    }
    // The retry removed the error card with its focused Retry button.
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
    }
  }

  /**
   * Load entities from the stored entityConfig (original input format)
   */
  private loadEntitiesFromConfig(entityConfig: any[]): void {
    for (const entity of entityConfig) {
      if (entity.type === 'internal') {
        const entityGroup = new FormGroup<InternalEntityForm>({
          providerType: new FormControl(entity.providerType || 'attestation-provider', {
            nonNullable: true,
          }),
          type: new FormControl('internal', { nonNullable: true }),
          issuerKeyChainId: new FormControl(entity.issuerKeyChainId || '', {
            nonNullable: true,
            validators: Validators.required,
          }),
          revocationKeyChainId: new FormControl(entity.revocationKeyChainId || '', {
            nonNullable: true,
            validators: Validators.required,
          }),
          infoName: new FormControl(entity.info?.name || '', {
            nonNullable: true,
            validators: Validators.required,
          }),
          infoLang: new FormControl(entity.info?.lang || 'en', { nonNullable: true }),
          infoUri: new FormControl(entity.info?.uri || '', { nonNullable: true }),
          infoCountry: new FormControl(entity.info?.country || '', { nonNullable: true }),
          infoLocality: new FormControl(entity.info?.locality || '', { nonNullable: true }),
          infoPostalCode: new FormControl(entity.info?.postalCode || '', { nonNullable: true }),
          infoStreetAddress: new FormControl(entity.info?.streetAddress || '', {
            nonNullable: true,
          }),
          infoContactUri: new FormControl(entity.info?.contactUri || '', { nonNullable: true }),
        });
        this.entitiesArray.push(entityGroup);
      } else {
        const entityGroup = new FormGroup<ExternalEntityForm>({
          providerType: new FormControl(entity.providerType || 'attestation-provider', {
            nonNullable: true,
          }),
          type: new FormControl('external', { nonNullable: true }),
          issuerCertPem: new FormControl(entity.issuerCertPem || '', {
            nonNullable: true,
            validators: Validators.required,
          }),
          revocationCertPem: new FormControl(entity.revocationCertPem || '', {
            nonNullable: true,
            validators: Validators.required,
          }),
          infoName: new FormControl(entity.info?.name || '', {
            nonNullable: true,
            validators: Validators.required,
          }),
          infoLang: new FormControl(entity.info?.lang || 'en', { nonNullable: true }),
          infoUri: new FormControl(entity.info?.uri || '', { nonNullable: true }),
          infoCountry: new FormControl(entity.info?.country || '', { nonNullable: true }),
          infoLocality: new FormControl(entity.info?.locality || '', { nonNullable: true }),
          infoPostalCode: new FormControl(entity.info?.postalCode || '', { nonNullable: true }),
          infoStreetAddress: new FormControl(entity.info?.streetAddress || '', {
            nonNullable: true,
          }),
          infoContactUri: new FormControl(entity.info?.contactUri || '', { nonNullable: true }),
        });
        this.entitiesArray.push(entityGroup);
      }
    }
  }

  /**
   * Parse entities from the trust list data (fallback when entityConfig is not available).
   * All entities are loaded as external since we have the PEM data.
   */
  private loadEntitiesFromData(data: any): void {
    if (!data?.TrustedEntitiesList) return;

    for (const entity of data.TrustedEntitiesList) {
      const info = entity.TrustedEntityInformation;
      const services = entity.TrustedEntityServices || [];

      // Find issuance and revocation services
      const issuanceService = services.find((s: any) =>
        s.ServiceInformation?.ServiceTypeIdentifier?.includes('Issuance')
      );
      const revocationService = services.find((s: any) =>
        s.ServiceInformation?.ServiceTypeIdentifier?.includes('Revocation')
      );

      // Extract PEM certificates from base64
      const issuerCertPem = this.extractPemFromService(issuanceService);
      const revocationCertPem = this.extractPemFromService(revocationService);

      // Extract entity info
      const postalAddress = info?.TEAddress?.TEPostalAddress?.[0];
      const electronicAddress = info?.TEAddress?.TEElectronicAddress?.[0];
      const lang = info?.TEName?.[0]?.lang || 'en';

      // Create external entity form with loaded data
      const entityGroup = new FormGroup<ExternalEntityForm>({
        providerType: new FormControl<'attestation-provider' | 'wallet-provider'>(
          issuanceService?.ServiceInformation?.ServiceTypeIdentifier?.includes('/WalletSolution/')
            ? 'wallet-provider'
            : 'attestation-provider',
          { nonNullable: true }
        ),
        type: new FormControl('external', { nonNullable: true }),
        issuerCertPem: new FormControl(issuerCertPem, {
          nonNullable: true,
          validators: Validators.required,
        }),
        revocationCertPem: new FormControl(revocationCertPem, {
          nonNullable: true,
          validators: Validators.required,
        }),
        infoName: new FormControl(this.getLocalizedValue(info?.TEName), {
          nonNullable: true,
          validators: Validators.required,
        }),
        infoLang: new FormControl(lang, { nonNullable: true }),
        infoUri: new FormControl(this.getLocalizedUriValue(info?.TEInformationURI), {
          nonNullable: true,
        }),
        infoCountry: new FormControl(postalAddress?.Country || '', { nonNullable: true }),
        infoLocality: new FormControl(postalAddress?.Locality || '', { nonNullable: true }),
        infoPostalCode: new FormControl(postalAddress?.PostalCode || '', { nonNullable: true }),
        infoStreetAddress: new FormControl(postalAddress?.StreetAddress || '', {
          nonNullable: true,
        }),
        infoContactUri: new FormControl(
          this.getLocalizedUriValue(electronicAddress ? [electronicAddress] : undefined),
          { nonNullable: true }
        ),
      });
      this.entitiesArray.push(entityGroup);
    }
  }

  /**
   * Extract PEM certificate from a service's X509Certificates
   */
  private extractPemFromService(service: any): string {
    const certs = service?.ServiceInformation?.ServiceDigitalIdentity?.X509Certificates;
    if (!certs || certs.length === 0) return '';

    const base64Cert = certs[0].val;
    if (!base64Cert) return '';

    // Format as PEM
    const lines = base64Cert.match(/.{1,64}/g) || [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
  }

  /**
   * Get first localized value from an array of {lang, value} objects
   */
  private getLocalizedValue(items: { lang: string; value: string }[] | undefined): string {
    return items?.[0]?.value || '';
  }

  /**
   * Get first localized URI value from an array of {lang, uriValue} objects
   */
  private getLocalizedUriValue(items: { lang: string; uriValue: string }[] | undefined): string {
    return items?.[0]?.uriValue || '';
  }

  addInternalEntity(): void {
    const entityGroup = new FormGroup<InternalEntityForm>({
      providerType: new FormControl<'attestation-provider' | 'wallet-provider'>(
        'attestation-provider',
        { nonNullable: true }
      ),
      type: new FormControl('internal', { nonNullable: true }),
      issuerKeyChainId: new FormControl('', { nonNullable: true, validators: Validators.required }),
      revocationKeyChainId: new FormControl('', {
        nonNullable: true,
        validators: Validators.required,
      }),
      infoName: new FormControl('', { nonNullable: true, validators: Validators.required }),
      infoLang: new FormControl('en', { nonNullable: true }),
      infoUri: new FormControl('', { nonNullable: true }),
      infoCountry: new FormControl('', { nonNullable: true }),
      infoLocality: new FormControl('', { nonNullable: true }),
      infoPostalCode: new FormControl('', { nonNullable: true }),
      infoStreetAddress: new FormControl('', { nonNullable: true }),
      infoContactUri: new FormControl('', { nonNullable: true }),
    });
    this.entitiesArray.push(entityGroup);
  }

  addExternalEntity(): void {
    const entityGroup = new FormGroup<ExternalEntityForm>({
      providerType: new FormControl<'attestation-provider' | 'wallet-provider'>(
        'attestation-provider',
        { nonNullable: true }
      ),
      type: new FormControl('external', { nonNullable: true }),
      issuerCertPem: new FormControl('', { nonNullable: true, validators: Validators.required }),
      revocationCertPem: new FormControl('', {
        nonNullable: true,
        validators: Validators.required,
      }),
      infoName: new FormControl('', { nonNullable: true, validators: Validators.required }),
      infoLang: new FormControl('en', { nonNullable: true }),
      infoUri: new FormControl('', { nonNullable: true }),
      infoCountry: new FormControl('', { nonNullable: true }),
      infoLocality: new FormControl('', { nonNullable: true }),
      infoPostalCode: new FormControl('', { nonNullable: true }),
      infoStreetAddress: new FormControl('', { nonNullable: true }),
      infoContactUri: new FormControl('', { nonNullable: true }),
    });
    this.entitiesArray.push(entityGroup);
  }

  removeEntity(index: number): void {
    this.entitiesArray.removeAt(index);
    focusRowAfterRemoval(
      this.injector,
      () => this.entityHeaders?.map((header) => header.nativeElement),
      index,
      () => this.addEntityButton?.nativeElement
    );
  }

  getEntityType(index: number): 'internal' | 'external' {
    return this.entitiesArray.at(index).get('type')?.value;
  }

  getKeyChainDescription(keyChainId: string): string {
    const keyChain = this.availableKeyChains.find((kc) => kc.id === keyChainId);
    return keyChain?.description || keyChainId;
  }

  /** How the header and the messages of the page name the entity at `index`. */
  entityLabel(index: number): string {
    return `${this.getEntityType(index) === 'internal' ? 'Internal' : 'External'} Entity #${index + 1}`;
  }

  async onSubmit(): Promise<void> {
    if (this.saving) return;
    if (this.form.invalid || this.entitiesArray.length === 0) {
      this.showWhatBlocksSaving();
      return;
    }

    const formValue = this.form.value;

    // Transform entities to API format (both internal and external now have info)
    const entities = formValue.entities.map((entity: any) => {
      const info = {
        name: entity.infoName,
        lang: entity.infoLang || undefined,
        uri: entity.infoUri || undefined,
        country: entity.infoCountry || undefined,
        locality: entity.infoLocality || undefined,
        postalCode: entity.infoPostalCode || undefined,
        streetAddress: entity.infoStreetAddress || undefined,
        contactUri: entity.infoContactUri || undefined,
      };

      if (entity.type === 'internal') {
        return {
          type: 'internal',
          providerType: entity.providerType,
          issuerKeyChainId: entity.issuerKeyChainId,
          revocationKeyChainId: entity.revocationKeyChainId,
          info,
        };
      } else {
        return {
          type: 'external',
          providerType: entity.providerType,
          issuerCertPem: entity.issuerCertPem,
          revocationCertPem: entity.revocationCertPem,
          info,
        };
      }
    });

    const body = {
      id: formValue.id,
      description: formValue.description || undefined,
      keyChainId: formValue.keyChainId || undefined,
      entities,
    };

    this.saving = true;
    try {
      if (this.trustListId) {
        // Update existing trust list
        await trustListControllerUpdateTrustList({
          path: { id: this.trustListId },
          body,
        });
      } else {
        await trustListControllerCreateTrustList({ body });
      }

      this.snackBar.open(
        this.trustListId ? 'Trust list updated successfully' : 'Trust list created successfully',
        'Close',
        { duration: 3000 }
      );

      this.router.navigate(['/trust-list']);
    } catch (error) {
      console.error('Failed to save trust list:', error);
      openErrorSnackBar(
        this.snackBar,
        showIssuesAtFields(this.form, error, 'Failed to save trust list', trustListControlPath)
      );
      for (const entity of this.entitiesArray.controls as FormGroup[]) {
        if (Object.values(entity.controls).some((control) => control.hasError('server'))) {
          this.rejectedEntities.add(entity);
        }
      }
    } finally {
      this.saving = false;
    }
  }

  /**
   * Save stays usable while the form is incomplete, so a click on it says what is missing: it
   * marks every field, names the sections with errors, opens the first entity with one (the
   * accordion shows one entity at a time, so it may be collapsed) and moves focus to the first
   * field with an error, or to Add Internal Entity when no entity is listed.
   */
  private showWhatBlocksSaving(): void {
    this.form.markAllAsTouched();
    const entities = this.entitiesArray.controls;
    const sections = sectionsWithErrors([
      {
        name: 'Basic Information',
        controls: Object.entries(this.form.controls)
          .filter(([name]) => name !== 'entities')
          .map(([, control]) => control),
      },
      ...entities.map((entity, index) => ({ name: this.entityLabel(index), controls: [entity] })),
    ]);
    const problems: string[] = [];
    if (sections.length) problems.push(fieldsToFixMessage(sections));
    if (entities.length === 0) problems.push('Add at least one trusted entity.');
    openErrorSnackBar(this.snackBar, problems.join(' '));

    const firstInvalidEntity = entities.findIndex((entity) => entity.invalid);
    const panel = firstInvalidEntity >= 0 ? this.entityPanels?.get(firstInvalidEntity) : undefined;
    panel?.open();
    focusFieldToFix(this.injector, () => this.formElement?.nativeElement, {
      panel,
      fallback: () => this.addEntityButton?.nativeElement,
    });
  }

  /** Whether a field shows its error, by the same rule as the Material form fields. */
  private showsError(control: AbstractControl | null | undefined): boolean {
    return this.errorStateMatcher.isErrorState(control ?? null, this.formDirective ?? null);
  }

  /** Whether one of the entity's fields shows an error, which its header says while it is collapsed. */
  entityShowsErrors(entity: AbstractControl): boolean {
    return Object.values((entity as FormGroup).controls).some((control) =>
      this.showsError(control)
    );
  }

  /** Message under a field: the backend's issue, else the local validator's message. */
  fieldError(path: string, localMessage = ''): string {
    return fieldErrorMessage(this.form.get(path), localMessage);
  }

  /**
   * Message under a certificate editor, which has no form field to decide when it shows one: the
   * backend's issue, else `requiredMessage` once the empty editor shows its error.
   */
  certificateError(path: string, requiredMessage: string): string {
    const control = this.form.get(path);
    const required = this.showsError(control) && control?.hasError('required');
    return fieldErrorMessage(control, required ? requiredMessage : '');
  }
}

/** Under a key chain select whose key chain, named by `subject`, no longer exists. */
function missingKeyChainMessage(subject: string): string {
  return `${subject} does not exist, so saving fails. Choose another.`;
}

/**
 * The form control for a request path: the form flattens an entity's `info`
 * into `info*` fields and does not show an entity's `type`.
 */
function trustListControlPath(path: string): string | null {
  if (/^entities\.\d+\.type$/.test(path)) return null;
  return path.replace(
    /^(entities\.\d+\.)info\.(\w)(\w*)$/,
    (_, entity: string, first: string, rest: string) => `${entity}info${first.toUpperCase()}${rest}`
  );
}
