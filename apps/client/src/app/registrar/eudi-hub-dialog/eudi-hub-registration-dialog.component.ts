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
import { labelOf, languageOf } from '../../utils/language-options';
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
      /** The purpose kept in the configuration's `registration_cert`, to start from. */
      purpose?: { lang: string; content: string }[];
      /** The privacy policy kept in the configuration's `registration_cert`, to start from. */
      privacyPolicy?: string;
    }
  | {
      kind: 'issuer';
      defaultName: string;
      /** The support URI kept in the issuance configuration, to start from. */
      supportUri?: string;
    };

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

interface PurposeText {
  lang: string;
  content: string;
}

// These rules mirror the backend: PurposeTextSchema (eudi-hub-request.dto.ts)
// and hubPurpose (registrar/eudi-hub/domain/hub-credentials.ts). Change them
// together.

/** A language tag as the backend accepts it, such as de, en or pt-BR. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** The backend takes at most 50 purpose texts, German and English included. */
const MAX_OTHER_PURPOSES = 48;

/** The EUDI Hub takes at most 24 purpose texts, German and English included. */
const MAX_HUB_PURPOSES = 24;

/**
 * Requests a registration certificate from the German EUDI Hub and stores it:
 * for a verifier in a presentation configuration, whose DCQL query the backend
 * registers as a credential request, together with the purpose and privacy
 * policy; for an issuer in the issuance configuration. The values kept from
 * the last request start the form, so renewing needs only the token and the
 * organization. Once an organization is chosen, its identifier, service
 * description, contact and privacy policy URLs are read from the EUDI Hub to
 * fill empty fields.
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
    const controls = this.form.controls;
    if (this.data.kind === 'issuer') {
      // An issuer certificate names credential types, not a purpose.
      controls.purposeDe.disable();
      controls.purposeEn.disable();
      controls.privacyPolicy.disable();
      controls.supportUri.setValue(this.data.supportUri ?? '');
    } else {
      controls.purposeDe.setValue(this.keptPurposeIn('de')?.content ?? '');
      controls.purposeEn.setValue(this.keptPurposeIn('en')?.content ?? '');
      controls.privacyPolicy.setValue(this.data.privacyPolicy ?? '');
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
                ...this.otherPurposes,
              ],
              privacyPolicy: value.privacyPolicy.trim(),
            })
          : this.eudiHub.requestIssuerRegistrationCertificate(common),
      'The EUDI Hub did not issue a registration certificate',
      'A certificate may have been stored anyway: close this dialog to see what the configuration holds before you request again.'
    );
  }

  /**
   * The kept purpose that fills the German or English field: the text tagged
   * exactly so, else the first one of that language in any case or region,
   * such as DE or de-DE.
   */
  private keptPurposeIn(lang: string): PurposeText | undefined {
    if (this.data.kind !== 'presentation') return undefined;
    const purpose = this.data.purpose ?? [];
    return (
      purpose.find((entry) => entry.lang === lang) ??
      purpose.find((entry) => languageOf(entry.lang) === lang)
    );
  }

  /** The kept texts that fill the German and English fields. */
  private get prefillSources(): Set<PurposeText> {
    return new Set(
      [this.keptPurposeIn('de'), this.keptPurposeIn('en')].filter(
        (entry): entry is PurposeText => !!entry
      )
    );
  }

  /**
   * Kept texts in other languages the request carries along: a valid tag, a
   * text, each language once, at most 48. Since the stored purpose is
   * replaced by what the request carries, every other kept text is removed.
   */
  private get sentOtherTexts(): PurposeText[] {
    if (this.data.kind !== 'presentation') return [];
    const sources = this.prefillSources;
    const seen = new Set(['de', 'en']);
    return (this.data.purpose ?? [])
      .filter((entry) => !sources.has(entry))
      .filter((entry) => entry.content.trim() && LANGUAGE_TAG.test(entry.lang))
      .filter((entry) => !seen.has(entry.lang) && seen.add(entry.lang))
      .slice(0, MAX_OTHER_PURPOSES);
  }

  /**
   * Kept purposes in other languages, sent along unchanged. The backend
   * stores them all and passes the EUDI Hub those with two-letter codes.
   */
  get otherPurposes(): PurposeText[] {
    return this.sentOtherTexts.map(({ lang, content }) => ({ lang, content: content.trim() }));
  }

  /** Kept texts this request removes from the configuration, each with the reason. */
  get purposesDropped(): { lang: string; reason: string }[] {
    if (this.data.kind !== 'presentation') return [];
    const kept = new Set<PurposeText>([...this.prefillSources, ...this.sentOtherTexts]);
    const seen = new Set<string>();
    const dropped: { lang: string; reason: string }[] = [];
    for (const entry of this.data.purpose ?? []) {
      if (kept.has(entry)) {
        seen.add(entry.lang);
        continue;
      }
      let reason = 'more than 50 texts';
      if (!entry.content.trim()) reason = 'empty text';
      else if (!LANGUAGE_TAG.test(entry.lang)) reason = 'no valid language tag';
      else if (seen.has(entry.lang) || entry.lang === 'de' || entry.lang === 'en') {
        reason = 'language given twice';
      }
      seen.add(entry.lang);
      dropped.push({ lang: entry.lang, reason });
    }
    return dropped;
  }

  /**
   * Kept purpose languages stored again but not sent to the EUDI Hub, by the
   * backend's rule: two-letter codes only, at most 24 texts with German and
   * English first.
   */
  get purposesNotSentToHub(): string[] {
    const twoLetter = this.otherPurposes
      .map(({ lang }) => lang)
      .filter((lang) => /^[a-z]{2}$/.test(lang));
    const sent = new Set(twoLetter.slice(0, MAX_HUB_PURPOSES - 2));
    return this.otherPurposes.map(({ lang }) => lang).filter((lang) => !sent.has(lang));
  }

  /** Kept purpose languages that go into the certificate. */
  get purposesInCertificate(): string[] {
    const notSent = new Set(this.purposesNotSentToHub);
    return this.otherPurposes.map(({ lang }) => lang).filter((lang) => !notSent.has(lang));
  }

  /** Language names for the note, such as "French (fr), Portuguese (pt-BR)". */
  languageLabels(tags: string[]): string {
    return tags.map((tag) => labelOf(tag)).join(', ');
  }
}
