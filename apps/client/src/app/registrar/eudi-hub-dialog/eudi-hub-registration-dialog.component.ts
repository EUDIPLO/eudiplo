import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { EudiHubPresentationRegistrationCertificateRequestDto } from '@eudiplo/sdk-core';
import { hasHttpStatus } from '../../utils/error-message';
import type {
  EudiHubOrganizationDetails,
  EudiHubRegistrationCertificate,
} from '../eudi-hub.service';
import { EudiHubAccountFieldsComponent } from './eudi-hub-account-fields.component';
import { EudiHubTokenDialog, httpUrlControl } from './eudi-hub-token-dialog';

/** Where the certificate goes: a presentation configuration, or the issuance configuration. */
export type EudiHubRegistrationDialogData =
  | {
      kind: 'presentation';
      presentationConfigId: string;
      /** Name the EUDI Hub shows when the user enters none. */
      defaultName: string;
      /** An English purpose already configured, to start from. */
      purposeEn?: string;
    }
  | { kind: 'issuer'; defaultName: string };

/** Identifier scheme as the backend accepts it; a scheme it drops breaks this list's build. */
type IdentifierType = EudiHubPresentationRegistrationCertificateRequestDto['identifier']['type'];

// Identifier scheme names (URIs), never fetched.
const EU_ID = 'http://data.europa.eu/eudi/id/'; // NOSONAR: scheme name
const HUB_ID = 'http://data.eudi-hub.de/eudi/id/'; // NOSONAR: scheme name

/** Identifier schemes the EUDI Hub accepts, with the label shown. */
const IDENTIFIER_TYPES: { value: IdentifierType; label: string }[] = [
  { value: `${EU_ID}EUID`, label: 'EUID' },
  { value: `${EU_ID}LEI`, label: 'LEI' },
  { value: `${EU_ID}VATIN`, label: 'VAT number' },
  { value: `${EU_ID}TIN`, label: 'Tax number' },
  { value: `${EU_ID}EORI-No`, label: 'EORI number' },
  { value: `${EU_ID}Excise`, label: 'Excise number' },
  {
    value: `${HUB_ID}Handelsregisternummer`,
    label: 'Handelsregisternummer',
  },
  {
    value: `${HUB_ID}DatenuebermittlerPseudonymId`,
    label: 'ELSTER pseudonym',
  },
];

function text(maxLength = 2000): FormControl<string> {
  return new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(maxLength)],
  });
}

/**
 * Requests a registration certificate from the German EUDI Hub and stores it
 * as an imported certificate: for a verifier in a presentation configuration,
 * whose DCQL query the backend registers as a credential request, for an
 * issuer in the issuance configuration. Once an organization is chosen, its
 * identifier, service description, contact and privacy policy URLs are read
 * from the EUDI Hub to fill empty fields.
 */
@Component({
  selector: 'app-eudi-hub-registration-dialog',
  standalone: true,
  imports: [
    EudiHubAccountFieldsComponent,
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
  ],
  templateUrl: './eudi-hub-registration-dialog.component.html',
  styleUrl: './eudi-hub-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EudiHubRegistrationDialogComponent extends EudiHubTokenDialog<EudiHubRegistrationCertificate> {
  readonly data = inject<EudiHubRegistrationDialogData>(MAT_DIALOG_DATA);
  readonly identifierTypes = IDENTIFIER_TYPES;

  readonly form = new FormGroup({
    token: this.token,
    organizationId: this.organizationId,
    environment: this.environment,
    identifierType: new FormControl<IdentifierType>(IDENTIFIER_TYPES[0].value, {
      nonNullable: true,
    }),
    identifierValue: text(200),
    serviceDescriptionDe: text(),
    serviceDescriptionEn: text(),
    purposeDe: text(),
    purposeEn: text(),
    privacyPolicy: httpUrlControl(),
    supportUri: httpUrlControl(),
    infoUri: httpUrlControl(),
    name: new FormControl('', { nonNullable: true }),
  });

  readonly loadingDetails = signal(false);
  /** Why the organization's data could not be read. */
  readonly detailsError = signal<string | undefined>(undefined);
  /** The data could not be read for another reason than the token, so it is entered by hand. */
  readonly detailsByHand = signal(false);
  /** The organization whose data filled the form, so it is read once. */
  private detailsFor?: string;
  /** The values an organization filled in; a field still holding one is refilled for the next. */
  private readonly filled = new Map<FormControl<string>, string>();
  /** The organization changed while its predecessor's data was being read. */
  private detailsOutdated = false;

  constructor() {
    super();
    if (this.data.kind === 'issuer') {
      // An issuer certificate names credential types, not a purpose.
      this.form.controls.purposeDe.disable();
      this.form.controls.purposeEn.disable();
      this.form.controls.privacyPolicy.disable();
    } else if (this.data.purposeEn) {
      this.form.controls.purposeEn.setValue(this.data.purposeEn);
    }
    // Once both token and organization are valid, in either order.
    for (const control of [this.organizationId, this.token]) {
      control.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => void this.loadDetails());
    }
  }

  get isPresentation(): boolean {
    return this.data.kind === 'presentation';
  }

  /**
   * Fills the fields from what the EUDI Hub knows about the chosen
   * organization. A field the user changed is kept; one an earlier
   * organization filled is replaced, so the request carries the data of the
   * organization it goes to.
   */
  async loadDetails(): Promise<void> {
    const organizationId = this.organizationId.value.trim();
    if (this.token.invalid || this.organizationId.invalid || organizationId === this.detailsFor) {
      return;
    }
    if (this.loadingDetails()) {
      this.detailsOutdated = true;
      return;
    }
    this.loadingDetails.set(true);
    this.detailsError.set(undefined);
    try {
      const details = await this.eudiHub.organizationDetails(this.token.value, organizationId);
      // Data of an organization no longer chosen is not filled in.
      if (this.organizationId.value.trim() === organizationId) {
        this.detailsFor = organizationId;
        this.fill(details);
      }
    } catch (error) {
      this.detailsError.set(
        this.errorMessage(error, 'Could not read the organization at the EUDI Hub')
      );
      // A refused token fails the request too; a fresh one is the fix then.
      this.detailsByHand.set(!hasHttpStatus(error, 400));
    } finally {
      this.loadingDetails.set(false);
      if (this.detailsOutdated) {
        this.detailsOutdated = false;
        void this.loadDetails();
      }
    }
  }

  private fill(details: EudiHubOrganizationDetails): void {
    const controls = this.form.controls;
    const set = (control: FormControl<string>, value: string | undefined) => {
      const current = control.value.trim();
      if (current && current !== this.filled.get(control)) return;
      control.setValue(value ?? '');
      this.filled.set(control, value ?? '');
    };
    const identifier = details.identifiers.find(({ type }) =>
      IDENTIFIER_TYPES.some((known) => known.value === type)
    );
    const identifierValue = controls.identifierValue.value.trim();
    if (!identifierValue || identifierValue === this.filled.get(controls.identifierValue)) {
      if (identifier) controls.identifierType.setValue(identifier.type as IdentifierType);
      set(controls.identifierValue, identifier?.value);
    }
    const description = details.serviceDescriptions.find(({ descriptions }) =>
      ['de', 'en'].every((lang) => descriptions.some((entry) => entry.lang === lang))
    );
    const inLanguage = (lang: string) =>
      description?.descriptions.find((entry) => entry.lang === lang)?.content;
    set(controls.serviceDescriptionDe, inLanguage('de'));
    set(controls.serviceDescriptionEn, inLanguage('en'));
    set(controls.supportUri, details.supportUris[0]);
    set(controls.infoUri, details.infoUris[0]);
    if (this.isPresentation) set(controls.privacyPolicy, details.privacyPolicyUris[0]);
  }

  async submit(): Promise<void> {
    if (this.requesting()) return;
    if (this.form.invalid) {
      this.showFieldsToFix(this.form);
      return;
    }
    const value = this.form.getRawValue();
    const common = {
      token: value.token,
      organizationId: value.organizationId.trim(),
      environment: value.environment,
      identifier: {
        type: value.identifierType,
        value: value.identifierValue.trim(),
      },
      serviceDescription: [
        { lang: 'de', content: value.serviceDescriptionDe.trim() },
        { lang: 'en', content: value.serviceDescriptionEn.trim() },
      ],
      supportUri: value.supportUri.trim(),
      infoUri: value.infoUri.trim(),
      name: value.name.trim() || undefined,
    };
    const data = this.data;
    await this.run(
      () =>
        data.kind === 'presentation'
          ? this.eudiHub.requestPresentationRegistrationCertificate({
              ...common,
              presentationConfigId: data.presentationConfigId,
              purpose: [
                { lang: 'de', content: value.purposeDe.trim() },
                { lang: 'en', content: value.purposeEn.trim() },
              ],
              privacyPolicy: value.privacyPolicy.trim(),
            })
          : this.eudiHub.requestIssuerRegistrationCertificate(common),
      'The EUDI Hub did not issue a registration certificate',
      'A certificate may have been stored anyway: close this dialog to see what the configuration holds before you request again.'
    );
  }
}
