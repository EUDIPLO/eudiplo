import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { describe, expect, it, vi } from 'vitest';

import { EudiHubService } from '../eudi-hub.service';
import { EudiHubDialogComponent } from './eudi-hub-dialog.component';

const ORG = '01932c5a-9abc-7000-8000-000000000010';

function createDialog() {
  const eudiHub = {
    listOrganizations: vi.fn(),
    requestAccessCertificate: vi.fn(),
  };
  const dialogRef = { close: vi.fn() };
  TestBed.configureTestingModule({
    imports: [EudiHubDialogComponent],
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: { keyId: 'access', description: 'Verifier key' } },
      { provide: MatDialogRef, useValue: dialogRef },
      { provide: EudiHubService, useValue: eudiHub },
    ],
  });
  const fixture = TestBed.createComponent(EudiHubDialogComponent);
  fixture.detectChanges();
  return { fixture, dialog: fixture.componentInstance, eudiHub, dialogRef };
}

/** What the SDK throws for an error answer of the backend. */
function refusal(message: string) {
  return { statusCode: 400, message };
}

describe('EudiHubDialogComponent', () => {
  it('selects the only organization of the token', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.listOrganizations.mockResolvedValue([{ id: ORG, name: 'Example Org' }]);
    dialog.form.controls.token.setValue('Bearer abc');

    await dialog.loadOrganizations();

    expect(eudiHub.listOrganizations).toHaveBeenCalledWith('Bearer abc');
    expect(dialog.form.controls.organizationId.value).toBe(ORG);
  });

  it('does not load organizations without a token', async () => {
    const { dialog, eudiHub } = createDialog();

    await dialog.loadOrganizations();

    expect(eudiHub.listOrganizations).not.toHaveBeenCalled();
    expect(dialog.form.controls.token.touched).toBe(true);
  });

  it('keeps the organization ID field when the organizations cannot be loaded', async () => {
    const { dialog, eudiHub, fixture } = createDialog();
    eudiHub.listOrganizations.mockRejectedValue(refusal('token expired'));
    dialog.form.controls.token.setValue('abc');

    await dialog.loadOrganizations();
    fixture.detectChanges();

    expect(dialog.organizationsError()).toContain('token expired');
    expect(dialog.organizationsError()).toContain('enter the organization ID by hand');
    expect(dialog.error()).toBeUndefined();
    const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('token expired');
  });

  it('requests the certificate and closes with it', async () => {
    const { dialog, eudiHub, dialogRef } = createDialog();
    const certificate = { id: 'hub-1', certId: 'access', crt: 'PEM', environment: 'live' };
    eudiHub.requestAccessCertificate.mockResolvedValue(certificate);
    dialog.form.setValue({
      token: 'abc',
      organizationId: ORG,
      environment: 'live',
      supportUri: ' https://support.example ',
      name: '  ',
    });

    await dialog.submit();

    expect(eudiHub.requestAccessCertificate).toHaveBeenCalledWith({
      token: 'abc',
      organizationId: ORG,
      keyId: 'access',
      environment: 'live',
      supportUri: 'https://support.example',
      name: undefined,
    });
    expect(dialogRef.close).toHaveBeenCalledWith(certificate);
  });

  it('shows why the EUDI Hub refused and stays open', async () => {
    const { dialog, eudiHub, dialogRef } = createDialog();
    eudiHub.requestAccessCertificate.mockRejectedValue(refusal('HTTP 403'));
    dialog.form.setValue({
      token: 'abc',
      organizationId: ORG,
      environment: 'sandbox',
      supportUri: 'https://support.example',
      name: '',
    });

    await dialog.submit();

    expect(dialog.error()).toContain('HTTP 403');
    expect(dialog.requesting()).toBe(false);
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('does not send an incomplete form', async () => {
    const { dialog, eudiHub } = createDialog();
    dialog.form.controls.token.setValue('abc');
    dialog.form.controls.organizationId.setValue('not-a-uuid');

    await dialog.submit();

    expect(eudiHub.requestAccessCertificate).not.toHaveBeenCalled();
    expect(dialog.form.controls.organizationId.hasError('pattern')).toBe(true);
    expect(dialog.form.controls.supportUri.hasError('required')).toBe(true);
  });

  it('defaults the certificate name to the key description', () => {
    const { dialog } = createDialog();

    expect(dialog.defaultName).toBe('Verifier key');
  });

  it('cannot be cancelled while the request runs', async () => {
    const { dialog, eudiHub, dialogRef } = createDialog();
    let resolve!: (value: unknown) => void;
    eudiHub.requestAccessCertificate.mockReturnValue(new Promise((r) => (resolve = r)));
    dialog.form.setValue({
      token: 'abc',
      organizationId: ORG,
      environment: 'sandbox',
      supportUri: 'https://support.example',
      name: '',
    });

    const submitting = dialog.submit();
    dialog.cancel();
    expect(dialogRef.close).not.toHaveBeenCalled();

    resolve({ id: 'hub-1' });
    await submitting;
    expect(dialogRef.close).toHaveBeenCalledWith({ id: 'hub-1' });
  });

  it('drops the organizations of an earlier token but keeps the chosen ID', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.listOrganizations.mockResolvedValue([{ id: ORG, name: 'Example Org' }]);
    dialog.form.controls.token.setValue('first');
    await dialog.loadOrganizations();

    dialog.form.controls.token.setValue('second');

    expect(dialog.organizations()).toBeUndefined();
    expect(dialog.form.controls.organizationId.value).toBe(ORG);
  });

  it('clears an ID typed by hand that the loaded organizations do not contain', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.listOrganizations.mockResolvedValue([
      { id: ORG, name: 'One' },
      { id: '01932c5a-9abc-7000-8000-000000000011', name: 'Two' },
    ]);
    dialog.form.controls.token.setValue('abc');
    dialog.form.controls.organizationId.setValue('01932c5a-9abc-7000-8000-0000000000ff');

    await dialog.loadOrganizations();

    expect(dialog.form.controls.organizationId.value).toBe('');
  });

  it('keeps an ID typed by hand that the loaded organizations contain', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.listOrganizations.mockResolvedValue([
      { id: ORG, name: 'One' },
      { id: '01932c5a-9abc-7000-8000-000000000011', name: 'Two' },
    ]);
    dialog.form.controls.token.setValue('abc');
    dialog.form.controls.organizationId.setValue(ORG);

    await dialog.loadOrganizations();

    expect(dialog.form.controls.organizationId.value).toBe(ORG);
  });

  it.each([
    ['the header name', 'Authorization: Bearer abc'],
    ['a line break inside', 'abc\ndef'],
  ])('refuses a token with %s before sending it', async (_, token) => {
    const { dialog, eudiHub } = createDialog();
    dialog.form.controls.token.setValue(token);

    await dialog.loadOrganizations();

    expect(dialog.form.controls.token.hasError('pattern')).toBe(true);
    expect(eudiHub.listOrganizations).not.toHaveBeenCalled();
  });

  it('accepts a token with the Bearer prefix', () => {
    const { dialog } = createDialog();
    dialog.form.controls.token.setValue('  Bearer abc.def-_~+/=  ');

    expect(dialog.form.controls.token.valid).toBe(true);
  });

  it('says a certificate may have been stored after a failure that is no refusal', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.requestAccessCertificate.mockRejectedValue(new TypeError('Failed to fetch'));
    dialog.form.setValue({
      token: 'abc',
      organizationId: ORG,
      environment: 'sandbox',
      supportUri: 'https://support.example',
      name: '',
    });

    await dialog.submit();

    expect(dialog.error()).toContain('A certificate may have been stored anyway');
  });

  it('ends the reason as a sentence before the hint to enter the ID by hand', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.listOrganizations.mockRejectedValue({ statusCode: 502, message: 'Bad Gateway' });
    dialog.form.controls.token.setValue('abc');

    await dialog.loadOrganizations();

    expect(dialog.organizationsError()).toMatch(
      /Bad Gateway\. You can still enter the organization ID by hand\.$/
    );
  });

  it('limits the support URI to what the backend accepts', () => {
    const { dialog } = createDialog();
    dialog.form.controls.supportUri.setValue(`https://x.example/${'a'.repeat(2048)}`);

    expect(dialog.form.controls.supportUri.hasError('maxlength')).toBe(true);
  });

  it('shows the backend message once, without the client fallback in front', async () => {
    const { dialog, eudiHub } = createDialog();
    eudiHub.requestAccessCertificate.mockRejectedValue({
      statusCode: 400,
      message: 'The EUDI Hub did not issue an access certificate: the EUDI Hub refused (HTTP 403).',
    });
    dialog.form.setValue({
      token: 'abc',
      organizationId: ORG,
      environment: 'sandbox',
      supportUri: 'https://support.example',
      name: '',
    });

    await dialog.submit();

    expect(dialog.error()).toBe(
      'The EUDI Hub did not issue an access certificate: the EUDI Hub refused (HTTP 403).'
    );
  });
});
