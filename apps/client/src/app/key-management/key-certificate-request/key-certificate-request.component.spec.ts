import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import type { KeyChainResponseDto } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { KeyChainService } from '../key-chain.service';
import { KeyCertificateRequestComponent } from './key-certificate-request.component';

const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----';
const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';

function keyChain(overrides: Partial<KeyChainResponseDto> = {}): KeyChainResponseDto {
  return {
    id: 'access-key',
    type: 'standalone',
    usageType: 'access',
    activePublicKey: { kty: 'EC', kid: 'kid-1' },
    activeCertificate: { pem: 'pem', subject: 'CN=access-key', issuer: 'CN=access-key' },
    rotationPolicy: { enabled: false },
    ...overrides,
  } as KeyChainResponseDto;
}

describe('KeyCertificateRequestComponent', () => {
  let fixture: ComponentFixture<KeyCertificateRequestComponent>;
  let component: KeyCertificateRequestComponent;
  let keyChainService: { createCsr: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let ownership: { get: ReturnType<typeof vi.fn> };

  /** Renders the card with its steps open, unless `expanded` is false. */
  function render(value: KeyChainResponseDto = keyChain(), expanded = true): void {
    fixture.componentRef.setInput('keyChain', value);
    fixture.componentRef.setInput('startExpanded', expanded);
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    keyChainService = {
      createCsr: vi.fn().mockResolvedValue(CSR),
      update: vi.fn().mockResolvedValue(undefined),
    };
    snackBar = { open: vi.fn() };
    ownership = { get: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({
      imports: [KeyCertificateRequestComponent],
      providers: [
        { provide: KeyChainService, useValue: keyChainService },
        { provide: ConfigOwnershipService, useValue: ownership },
        provideRouter([]),
      ],
    }).compileComponents();
    TestBed.overrideProvider(MatSnackBar, { useValue: snackBar });
    fixture = TestBed.createComponent(KeyCertificateRequestComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a CSR with the default subject and shows it', async () => {
    render();

    await component.createCsr();
    fixture.detectChanges();

    expect(keyChainService.createCsr).toHaveBeenCalledWith('access-key', '');
    const csrField = fixture.nativeElement.querySelector(
      'textarea[readonly]'
    ) as HTMLTextAreaElement;
    expect(csrField.value).toBe(CSR);
    expect(text()).toContain('Empty uses CN=access-key');
  });

  it('sends the subject the user entered', async () => {
    render();
    component.subject.setValue('  C=DE, O=Example, CN=Verifier ');

    await component.createCsr();

    expect(keyChainService.createCsr).toHaveBeenCalledWith(
      'access-key',
      'C=DE, O=Example, CN=Verifier'
    );
  });

  it('shows why the CSR was refused', async () => {
    keyChainService.createCsr.mockRejectedValue({
      message: 'The subject "x" is not a distinguished name',
    });
    render();

    await component.createCsr();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('The subject "x" is not a distinguished name');
  });

  it('stores the issued certificate and tells the page', async () => {
    render();
    const saved = vi.fn();
    component.certificateSaved.subscribe(saved);
    component.certificate.setValue(`  ${CERTIFICATE}\n`);

    await component.saveCertificate();

    expect(keyChainService.update).toHaveBeenCalledWith('access-key', {
      activeCertificate: CERTIFICATE,
    });
    expect(saved).toHaveBeenCalled();
    expect(component.certificate.value).toBe('');
  });

  it('keeps the certificate and says why when the backend refuses it', async () => {
    keyChainService.update.mockRejectedValue({
      message: 'activeCertificate: the first certificate is not issued for the active key',
    });
    render();
    const saved = vi.fn();
    component.certificateSaved.subscribe(saved);
    component.certificate.setValue(CERTIFICATE);

    await component.saveCertificate();
    fixture.detectChanges();

    expect(saved).not.toHaveBeenCalled();
    expect(component.certificate.value).toBe(CERTIFICATE);
    expect(text()).toContain('not issued for the active key');
  });

  it('asks before replacing a certificate issued by someone else', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      keyChain({
        activeCertificate: { pem: 'pem', subject: 'CN=RP', issuer: 'CN=Registrar CA' },
      } as Partial<KeyChainResponseDto>)
    );
    component.certificate.setValue(CERTIFICATE);

    await component.saveCertificate();

    expect(confirm.mock.lastCall?.[0]).toContain('issued by "CN=Registrar CA"');
    expect(keyChainService.update).not.toHaveBeenCalled();
  });

  it('does not ask before replacing the self-signed certificate', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render();
    component.certificate.setValue(CERTIFICATE);

    await component.saveCertificate();

    expect(confirm).not.toHaveBeenCalled();
    expect(keyChainService.update).toHaveBeenCalled();
  });

  it('warns that a rotation replaces the certificate', () => {
    render(keyChain({ rotationPolicy: { enabled: true, intervalDays: 30 } }));

    expect(text()).toContain('This key rotates automatically');
  });

  it('drops the CSR when the subject changes', async () => {
    render();
    await component.createCsr();

    component.subject.setValue('C=DE, CN=Other');

    expect(component.csr()).toBe('');
  });

  it('drops the refusal of the earlier subject when the subject changes', async () => {
    keyChainService.createCsr.mockRejectedValue({ message: 'not a distinguished name' });
    render();
    await component.createCsr();

    component.subject.setValue('C=DE, CN=Fixed');

    expect(component.csrError()).toBe('');
  });

  it('enables Store Certificate after certificate files were loaded', async () => {
    render();
    const store = fixture.debugElement
      .queryAll(By.css('button'))
      .find((b) => b.nativeElement.textContent.includes('Store Certificate'))!;
    expect(store.nativeElement.getAttribute('aria-disabled')).toBe('true');
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', {
      value: [new File([CERTIFICATE], 'cert.pem')],
    });

    await component.onCertificateFilesSelected({ target: input } as unknown as Event);
    fixture.detectChanges();

    expect(store.nativeElement.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('takes the user to the subject when the page opens the steps', async () => {
    document.body.appendChild(fixture.nativeElement);
    render();

    await vi.waitFor(() => expect(document.activeElement?.getAttribute('maxlength')).toBe('1024'));
    fixture.nativeElement.remove();
  });

  it('says why Store Certificate is disabled', () => {
    render();
    const store = fixture.debugElement
      .queryAll(By.css('button'))
      .find((b) => b.nativeElement.textContent.includes('Store Certificate'))!;
    const tooltip = store.injector.get(MatTooltip);

    expect(tooltip.message).toBe('Paste or load the certificate chain first');
    component.certificate.setValue(CERTIFICATE);
    fixture.detectChanges();
    expect(tooltip.message).toBe('');
  });

  it('drops the CSR when the key was rotated', async () => {
    render();
    await component.createCsr();

    render(keyChain({ activePublicKey: { kty: 'EC', kid: 'kid-2' } }));

    expect(component.csr()).toBe('');
  });

  it('hides the steps behind a button until the user asks for them', async () => {
    render(keyChain(), false);
    expect(text()).not.toContain('Create CSR');

    const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: HTMLElement) =>
      b.textContent?.includes('Request Certificate from External CA')
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();

    expect(text()).toContain('Create CSR');
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('maxlength')).toBe('1024'));
  });

  it('links the rotation warning to the edit page', () => {
    render(keyChain({ rotationPolicy: { enabled: true, intervalDays: 30 } }));

    const link = fixture.nativeElement.querySelector('.rotation-warning a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/keys/access-key/edit');
  });

  it('locks storing a certificate for a key chain managed by a file', async () => {
    ownership.get.mockResolvedValue({ ownership: 'file-managed', source: 'folder:key-chains' });
    render();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(ownership.get).toHaveBeenCalledWith('KeyChain', 'access-key');
    expect(text()).toContain('managed by folder:key-chains');
    expect(component.certificate.disabled).toBe(true);
    await component.saveCertificate();
    expect(keyChainService.update).not.toHaveBeenCalled();
  });

  it('starts empty for another key chain', async () => {
    render();
    component.subject.setValue('CN=Verifier');
    component.certificate.setValue(CERTIFICATE);
    await component.createCsr();

    render(keyChain({ id: 'other-key' }));

    expect(component.subject.value).toBe('');
    expect(component.certificate.value).toBe('');
    expect(component.csr()).toBe('');
  });

  it('drops a CSR that arrives after the page switched to another key chain', async () => {
    let answer!: (csr: string) => void;
    keyChainService.createCsr.mockReturnValue(new Promise<string>((resolve) => (answer = resolve)));
    render();
    const request = component.createCsr();

    render(keyChain({ id: 'other-key' }));
    answer(CSR);
    await request;

    expect(component.csr()).toBe('');
  });
});
