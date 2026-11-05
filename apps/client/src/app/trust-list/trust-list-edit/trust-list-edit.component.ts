import { CommonModule } from '@angular/common';
import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ElementRef,
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
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatRadioModule } from '@angular/material/radio';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatDividerModule } from '@angular/material/divider';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
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
import { focusRowAfterRemoval } from '../../common/focus-if-lost.util';

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
  ],
  templateUrl: './trust-list-edit.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './trust-list-edit.component.scss',
})
export class TrustListEditComponent implements OnInit {
  trustListId?: string | null;
  trustList?: TrustList;
  form!: FormGroup;
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

  editorOptionsPem = {
    automaticLayout: true,
    language: 'pem',
    minimap: { enabled: false },
  };

  // Where focus goes when the entity holding it is removed, in the order of the entities.
  @ViewChildren('entityHeader', { read: ElementRef })
  private readonly entityHeaders?: QueryList<ElementRef<HTMLElement>>;
  @ViewChild('addEntityButton', { read: ElementRef })
  private readonly addEntityButton?: ElementRef<HTMLElement>;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar,
    private readonly injector: Injector
  ) {}

  ngOnInit() {
    this.trustListId = this.route.snapshot.paramMap.get('id');

    this.form = new FormGroup({
      id: new FormControl('', { validators: [Validators.required] }),
      description: new FormControl(''),
      keyChainId: new FormControl(''),
      entities: new FormArray([]),
    });

    this.loadKeyChains();

    if (this.trustListId) {
      this.loadTrustList();
    }
  }

  get entitiesArray(): FormArray {
    return this.form.get('entities') as FormArray;
  }

  get isEditMode(): boolean {
    return !!this.trustListId;
  }

  private async loadKeyChains(): Promise<void> {
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
    } catch (error) {
      console.error('Failed to load key chains:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to load key chains'));
    }
  }

  private async loadTrustList(): Promise<void> {
    if (!this.trustListId) return;

    try {
      const response = await trustListControllerGetTrustList({
        path: { id: this.trustListId },
      });

      this.trustList = response.data;

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
    } catch (error) {
      console.error('Failed to load trust list:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to load trust list'));
      this.router.navigate(['/trust-list']);
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

  async onSubmit(): Promise<void> {
    if (this.saving) return;
    if (this.form.invalid) {
      this.snackBar.open('Please fill in all required fields', 'Close', {
        duration: 3000,
      });
      return;
    }

    if (this.entitiesArray.length === 0) {
      this.snackBar.open('Please add at least one entity', 'Close', {
        duration: 3000,
      });
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
        // Create new trust list - id is required
        if (!formValue.id) {
          this.snackBar.open('ID is required for creating a new trust list', 'Close', {
            duration: 5000,
          });
          return;
        }
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

  /** Message under a field: the backend's issue, else the local validator's message. */
  fieldError(path: string, localMessage = ''): string {
    return fieldErrorMessage(this.form.get(path), localMessage);
  }
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
