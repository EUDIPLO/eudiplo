import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { describe, expect, it, vi } from 'vitest';

import { EudiHubService } from '../eudi-hub.service';
import {
  EudiHubRegistrationDialogComponent,
  type EudiHubRegistrationDialogData,
} from './eudi-hub-registration-dialog.component';

const ORG = '01932c5a-9abc-7000-8000-000000000010';

const details = {
  id: ORG,
  name: 'Example',
  identifiers: [
    { type: 'urn:unknown', value: 'x' },
    { type: 'http://data.europa.eu/eudi/id/EUID', value: 'DE/HRB1' },
  ],
  serviceDescriptions: [
    { name: 'English only', descriptions: [{ lang: 'en', content: 'Only' }] },
    {
      name: 'General',
      descriptions: [
        { lang: 'de', content: 'Dienst' },
        { lang: 'en', content: 'Service' },
      ],
    },
  ],
  privacyPolicyUris: ['https://example.com/privacy'],
  supportUris: ['https://example.com/support'],
  infoUris: ['https://example.com'],
};

function createDialog(
  data: EudiHubRegistrationDialogData = {
    kind: 'presentation',
    presentationConfigId: 'age',
    defaultName: 'Age check',
    purpose: [{ lang: 'en', content: 'Age check' }],
  }
) {
  const eudiHub = {
    listOrganizations: vi.fn(),
    organizationDetails: vi.fn().mockResolvedValue(details),
    requestPresentationRegistrationCertificate: vi.fn(),
    requestIssuerRegistrationCertificate: vi.fn(),
  };
  const dialogRef = { close: vi.fn() };
  TestBed.configureTestingModule({
    imports: [EudiHubRegistrationDialogComponent],
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: data },
      { provide: MatDialogRef, useValue: dialogRef },
      { provide: EudiHubService, useValue: eudiHub },
    ],
  });
  const fixture = TestBed.createComponent(EudiHubRegistrationDialogComponent);
  fixture.detectChanges();
  return { fixture, dialog: fixture.componentInstance, eudiHub, dialogRef };
}

describe('EudiHubRegistrationDialogComponent', () => {
  it('fills empty fields from the organization once one is chosen', async () => {
    const { dialog, eudiHub } = createDialog();
    dialog.token.setValue('abc');
    dialog.form.controls.infoUri.setValue('https://mine.example');

    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    expect(eudiHub.organizationDetails).toHaveBeenCalledWith('abc', ORG);
    const value = dialog.form.getRawValue();
    expect(value).toMatchObject({
      identifierType: 'http://data.europa.eu/eudi/id/EUID',
      identifierValue: 'DE/HRB1',
      serviceDescriptionDe: 'Dienst',
      serviceDescriptionEn: 'Service',
      privacyPolicy: 'https://example.com/privacy',
      supportUri: 'https://example.com/support',
      // A value entered by hand is kept.
      infoUri: 'https://mine.example',
      purposeEn: 'Age check',
    });
  });

  it('reads the organization only once', async () => {
    const { dialog, eudiHub } = createDialog();
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    dialog.organizationId.setValue(` ${ORG} `);
    await dialog.loadDetails();

    expect(eudiHub.organizationDetails).toHaveBeenCalledTimes(1);
  });

  it('says the fields are entered by hand when the organization cannot be read', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.organizationDetails.mockRejectedValue({ statusCode: 403, message: 'HTTP 403' });
    dialog.token.setValue('abc');

    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    expect(dialog.detailsError()).toContain('HTTP 403');
  });

  it('requests a verifier certificate with both languages and closes with it', async () => {
    const { dialog, eudiHub, dialogRef } = createDialog();
    eudiHub.requestPresentationRegistrationCertificate.mockResolvedValue({ id: 'rc-1' });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));
    dialog.form.controls.purposeDe.setValue(' Altersprüfung ');

    await dialog.submit();

    expect(eudiHub.requestPresentationRegistrationCertificate).toHaveBeenCalledWith({
      token: 'abc',
      organizationId: ORG,
      environment: 'sandbox',
      identifier: { type: 'http://data.europa.eu/eudi/id/EUID', value: 'DE/HRB1' },
      serviceDescription: [
        { lang: 'de', content: 'Dienst' },
        { lang: 'en', content: 'Service' },
      ],
      supportUri: 'https://example.com/support',
      infoUri: 'https://example.com',
      name: undefined,
      presentationConfigId: 'age',
      purpose: [
        { lang: 'de', content: 'Altersprüfung' },
        { lang: 'en', content: 'Age check' },
      ],
      privacyPolicy: 'https://example.com/privacy',
    });
    expect(dialogRef.close).toHaveBeenCalledWith({ id: 'rc-1' });
  });

  it('starts from the purpose and privacy policy kept in the configuration', async () => {
    const { dialog, eudiHub } = createDialog({
      kind: 'presentation',
      presentationConfigId: 'age',
      defaultName: 'Age check',
      purpose: [
        { lang: 'de-DE', content: 'Altersprüfung' },
        { lang: 'en', content: 'Age check' },
      ],
      privacyPolicy: 'https://verifier.example/privacy',
    });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    expect(eudiHub.organizationDetails).toHaveBeenCalled();
    // The organization's privacy policy does not replace the kept one.
    expect(dialog.form.getRawValue()).toMatchObject({
      purposeDe: 'Altersprüfung',
      purposeEn: 'Age check',
      privacyPolicy: 'https://verifier.example/privacy',
    });
  });

  it('starts an issuer request from the kept support URI', () => {
    const { dialog } = createDialog({
      kind: 'issuer',
      defaultName: 'Issuer registration certificate',
      supportUri: 'https://issuer.example/support',
    });

    expect(dialog.form.controls.supportUri.value).toBe('https://issuer.example/support');
  });

  it('sends kept purposes in other languages along, so renewing keeps them', async () => {
    const { dialog, eudiHub } = createDialog({
      kind: 'presentation',
      presentationConfigId: 'age',
      defaultName: 'Age check',
      purpose: [
        { lang: 'de', content: 'Altersprüfung' },
        { lang: 'en', content: 'Age check' },
        { lang: 'fr', content: "Contrôle d'âge" },
        { lang: 'pt-BR', content: 'Verificação de idade' },
      ],
      privacyPolicy: 'https://verifier.example/privacy',
    });
    eudiHub.requestPresentationRegistrationCertificate.mockResolvedValue({ id: 'rc-1' });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    await dialog.submit();

    expect(eudiHub.requestPresentationRegistrationCertificate.mock.lastCall?.[0].purpose).toEqual([
      { lang: 'de', content: 'Altersprüfung' },
      { lang: 'en', content: 'Age check' },
      { lang: 'fr', content: "Contrôle d'âge" },
      { lang: 'pt-BR', content: 'Verificação de idade' },
    ]);
    expect(dialog.purposesNotSentToHub).toEqual(['pt-BR']);
  });

  it('does not send a regional German text twice when it prefilled the German field', async () => {
    const { dialog, eudiHub } = createDialog({
      kind: 'presentation',
      presentationConfigId: 'age',
      defaultName: 'Age check',
      purpose: [
        { lang: 'de-DE', content: 'Altersprüfung' },
        { lang: 'en', content: 'Age check' },
        { lang: 'de-AT', content: 'Altersprüfung (AT)' },
      ],
      privacyPolicy: 'https://verifier.example/privacy',
    });
    eudiHub.requestPresentationRegistrationCertificate.mockResolvedValue({ id: 'rc-1' });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    await dialog.submit();

    expect(eudiHub.requestPresentationRegistrationCertificate.mock.lastCall?.[0].purpose).toEqual([
      { lang: 'de', content: 'Altersprüfung' },
      { lang: 'en', content: 'Age check' },
      { lang: 'de-AT', content: 'Altersprüfung (AT)' },
    ]);
  });

  describe('note on kept purposes in other languages', () => {
    const dialogWith = (purpose: { lang: string; content: string }[]) =>
      createDialog({
        kind: 'presentation',
        presentationConfigId: 'age',
        defaultName: 'Age check',
        purpose: [
          { lang: 'de', content: 'Altersprüfung' },
          { lang: 'en', content: 'Age check' },
          ...purpose,
        ],
        privacyPolicy: 'https://verifier.example/privacy',
      });
    it('is not shown for German and English only', () => {
      const { fixture } = dialogWith([]);
      expect(fixture.nativeElement.querySelector('.purpose-other-languages')).toBeNull();
    });

    it('names what goes into the certificate and what is only stored, in their own sentences', () => {
      const { fixture } = dialogWith([
        { lang: 'fr', content: "Contrôle d'âge" },
        { lang: 'pt-BR', content: 'Verificação de idade' },
      ]);
      const [sent, stored] = [
        ...fixture.nativeElement.querySelectorAll('.purpose-other-languages p'),
      ].map((paragraph: HTMLElement) => paragraph.textContent ?? '');

      expect(sent).toContain('Also sent to the EUDI Hub');
      expect(sent).toContain('French (fr)');
      expect(sent).not.toContain('pt-BR');
      expect(stored).toContain('not part of the certificate');
      expect(stored).toContain('Portuguese (pt-BR)');
      expect(stored).not.toContain('(fr)');
      expect(fixture.nativeElement.querySelector('.purpose-dropped')).toBeNull();
    });

    it('warns about every kept text the request removes, with the reason, and leaves them out', async () => {
      const { fixture, dialog, eudiHub } = dialogWith([
        { lang: 'Portuguese', content: 'x' },
        { lang: 'fr', content: "Contrôle d'âge" },
        { lang: 'fr', content: 'Encore' },
        { lang: 'it', content: '   ' },
        { lang: 'de', content: 'Noch einmal' },
      ]);

      expect(dialog.purposesDropped).toEqual([
        { lang: 'Portuguese', reason: 'no valid language tag' },
        { lang: 'fr', reason: 'language given twice' },
        { lang: 'it', reason: 'empty text' },
        { lang: 'de', reason: 'language given twice' },
      ]);
      const warning = fixture.nativeElement.querySelector('.purpose-dropped');
      expect(warning?.getAttribute('role')).toBe('note');
      expect(warning?.textContent).toContain('removes these kept purpose texts');
      expect(warning?.querySelectorAll('li')).toHaveLength(4);

      eudiHub.requestPresentationRegistrationCertificate.mockResolvedValue({ id: 'rc-1' });
      dialog.token.setValue('abc');
      dialog.organizationId.setValue(ORG);
      await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));
      await dialog.submit();

      expect(eudiHub.requestPresentationRegistrationCertificate.mock.lastCall?.[0].purpose).toEqual(
        [
          { lang: 'de', content: 'Altersprüfung' },
          { lang: 'en', content: 'Age check' },
          { lang: 'fr', content: "Contrôle d'âge" },
        ]
      );
    });

    it('fills German and English from texts tagged in upper case and does not remove them', () => {
      const { dialog } = createDialog({
        kind: 'presentation',
        presentationConfigId: 'age',
        defaultName: 'Age check',
        purpose: [
          { lang: 'DE', content: 'Altersprüfung' },
          { lang: 'EN', content: 'Age check' },
        ],
        privacyPolicy: 'https://verifier.example/privacy',
      });

      expect(dialog.form.controls.purposeDe.value).toBe('Altersprüfung');
      expect(dialog.form.controls.purposeEn.value).toBe('Age check');
      expect(dialog.purposesDropped).toEqual([]);
    });

    it('applies the limits of the backend: 24 texts for the EUDI Hub, 50 stored', () => {
      const codes = Array.from(
        { length: 26 * 26 },
        (_, index) =>
          `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`
      ).filter((code) => code !== 'de' && code !== 'en');
      const { dialog } = dialogWith(
        codes.slice(0, 49).map((lang) => ({ lang, content: `text ${lang}` }))
      );

      expect(dialog.otherPurposes).toHaveLength(48);
      expect(dialog.purposesInCertificate).toHaveLength(22);
      expect(dialog.purposesNotSentToHub).toHaveLength(26);
      expect(dialog.purposesDropped).toEqual([{ lang: codes[48], reason: 'more than 50 texts' }]);
    });
  });

  it('does not send a verifier request without a German purpose', async () => {
    const { dialog, eudiHub } = createDialog();
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    await dialog.submit();

    expect(dialog.form.controls.purposeDe.hasError('required')).toBe(true);
    expect(eudiHub.requestPresentationRegistrationCertificate).not.toHaveBeenCalled();
  });

  it('asks an issuer for no purpose or privacy policy', async () => {
    const { dialog, eudiHub } = createDialog({
      kind: 'issuer',
      defaultName: 'Issuer registration certificate',
    });
    eudiHub.requestIssuerRegistrationCertificate.mockResolvedValue({ id: 'rc-2' });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    await dialog.submit();

    const body = eudiHub.requestIssuerRegistrationCertificate.mock.lastCall?.[0];
    expect(body).not.toHaveProperty('purpose');
    expect(body).not.toHaveProperty('privacyPolicy');
    expect(body).toMatchObject({ organizationId: ORG, infoUri: 'https://example.com' });
  });

  it('keeps the dialog open with the reason of a refusal', async () => {
    const { dialog, eudiHub, dialogRef } = createDialog({
      kind: 'issuer',
      defaultName: 'Issuer registration certificate',
    });
    eudiHub.requestIssuerRegistrationCertificate.mockRejectedValue({
      statusCode: 400,
      message: 'Create an SD-JWT VC credential configuration with a vct',
    });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    await dialog.submit();

    expect(dialog.error()).toContain('Create an SD-JWT VC credential configuration');
    expect(dialog.error()).not.toContain('may have been stored');
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('replaces the data of an earlier organization but keeps what the user changed', async () => {
    const { dialog, eudiHub } = createDialog();
    const other = '01932c5a-9abc-7000-8000-000000000011';
    eudiHub.organizationDetails.mockImplementation((_token: string, id: string) =>
      Promise.resolve(
        id === ORG
          ? details
          : {
              ...details,
              id: other,
              identifiers: [{ type: 'http://data.europa.eu/eudi/id/LEI', value: 'LEI-2' }],
              supportUris: ['https://other.example/support'],
              infoUris: [],
            }
      )
    );
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));
    dialog.form.controls.supportUri.setValue('https://mine.example/support');

    dialog.organizationId.setValue(other);
    await vi.waitFor(() => expect(eudiHub.organizationDetails).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(false));

    expect(dialog.form.getRawValue()).toMatchObject({
      identifierType: 'http://data.europa.eu/eudi/id/LEI',
      identifierValue: 'LEI-2',
      // Changed by hand, so kept.
      supportUri: 'https://mine.example/support',
      // The new organization has none, so the earlier one's is removed.
      infoUri: '',
    });
  });

  it('reads the organization chosen while an earlier one was still being read', async () => {
    const { dialog, eudiHub } = createDialog();
    const other = '01932c5a-9abc-7000-8000-000000000011';
    let release!: () => void;
    eudiHub.organizationDetails
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(details))))
      .mockResolvedValueOnce({ ...details, supportUris: ['https://other.example/support'] });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.loadingDetails()).toBe(true));

    dialog.organizationId.setValue(other);
    release();

    await vi.waitFor(() =>
      expect(eudiHub.organizationDetails).toHaveBeenLastCalledWith('abc', other)
    );
    await vi.waitFor(() =>
      expect(dialog.form.controls.supportUri.value).toBe('https://other.example/support')
    );
  });

  it('reads the organization once the token is pasted after its ID', async () => {
    const { dialog, eudiHub } = createDialog();
    dialog.organizationId.setValue(ORG);
    expect(eudiHub.organizationDetails).not.toHaveBeenCalled();

    dialog.token.setValue('abc');

    await vi.waitFor(() => expect(eudiHub.organizationDetails).toHaveBeenCalledWith('abc', ORG));
  });

  it('does not ask to enter the fields by hand when the token was refused', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.organizationDetails.mockRejectedValue({
      statusCode: 400,
      message: 'the EUDI Hub did not accept the access token (HTTP 401)',
    });
    dialog.token.setValue('abc');
    dialog.organizationId.setValue(ORG);
    await vi.waitFor(() => expect(dialog.detailsError()).toBeDefined());

    expect(dialog.detailsByHand()).toBe(false);

    eudiHub.organizationDetails.mockRejectedValue({ statusCode: 502, message: 'unreachable' });
    dialog.token.setValue('abcd');
    await vi.waitFor(() => expect(dialog.detailsByHand()).toBe(true));
  });
});
