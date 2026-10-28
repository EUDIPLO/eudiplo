import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  afterNextRender,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { KeyChainResponseDto } from '@eudiplo/sdk-core';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { getApiErrorMessage } from '../../utils/error-message';
import { readCertificateFiles } from '../certificate-files';
import { KeyChainService } from '../key-chain.service';

/**
 * Lets a CA outside EUDIPLO issue the certificate of a standalone key chain
 * while the key stays in EUDIPLO: the user creates a certificate signing
 * request (CSR) for the active key, hands it to the CA and stores the issued
 * certificate as the active certificate.
 */
@Component({
  selector: 'app-key-certificate-request',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTooltipModule,
    ConfigOwnershipDirective,
    RouterLink,
  ],
  templateUrl: './key-certificate-request.component.html',
  styleUrl: './key-certificate-request.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyCertificateRequestComponent {
  private readonly keyChainService = inject(KeyChainService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly injector = inject(Injector);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly ownership = inject(ConfigOwnershipService);

  @Input({ required: true }) set keyChain(keyChain: KeyChainResponseDto) {
    // A CSR belongs to the key it was created for; a rotation replaces the key.
    if (this.current && this.current.activePublicKey?.kid !== keyChain.activePublicKey?.kid) {
      this.csr.set('');
    }
    const otherKey = this.current?.id !== keyChain.id;
    if (otherKey) {
      this.csr.set('');
      this.subject.reset('');
      this.certificate.reset('');
      this.csrError.set('');
      this.saveError.set('');
      this.expanded.set(this.startExpanded);
    }
    this.current = keyChain;
    if (otherKey) void this.checkManaged(keyChain.id);
  }
  get keyChain(): KeyChainResponseDto {
    return this.current!;
  }
  private current?: KeyChainResponseDto;

  /** Shows the steps right away, for a key created to request its certificate. */
  @Input() set startExpanded(value: boolean) {
    this.startExpandedValue = value;
    if (!value) return;
    this.expanded.set(true);
    // The card is further down the page; take the user to its first field.
    afterNextRender(() => this.subjectInput?.nativeElement.focus(), { injector: this.injector });
  }
  get startExpanded(): boolean {
    return this.startExpandedValue;
  }
  private startExpandedValue = false;

  /** Emitted after the issued certificate was stored, so the page loads the key chain again. */
  @Output() readonly certificateSaved = new EventEmitter<void>();

  @ViewChild('csrText') private readonly csrText?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('subjectInput') private readonly subjectInput?: ElementRef<HTMLInputElement>;

  readonly subject = new FormControl('', { nonNullable: true });
  readonly certificate = new FormControl('', { nonNullable: true });

  /** The steps are hidden behind a button, as most keys keep their certificate. */
  readonly expanded = signal(false);
  /**
   * Source of the configuration file that manages the key chain. Its
   * certificate is stored in that file, so step 2 is locked up front.
   */
  readonly managedBy = signal<string | undefined>(undefined);
  readonly csr = signal('');
  readonly creatingCsr = signal(false);
  readonly csrError = signal('');
  readonly saving = signal(false);
  readonly saveError = signal('');

  constructor() {
    // A CSR shown next to another subject would be sent to the CA by mistake,
    // and a refusal of the earlier subject no longer applies.
    this.subject.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.csr.set('');
      this.csrError.set('');
    });
  }

  get defaultSubject(): string {
    return `CN=${this.keyChain.id}`;
  }

  get rotates(): boolean {
    return !!this.keyChain.rotationPolicy?.enabled;
  }

  /** Opens the steps; the button goes away, so the focus moves to the first field. */
  expand(): void {
    this.expanded.set(true);
    afterNextRender(() => this.subjectInput?.nativeElement.focus(), { injector: this.injector });
  }

  /**
   * Whether a configuration file manages the key chain. A failed lookup
   * leaves step 2 open; the backend refuses the change and says why.
   */
  private async checkManaged(keyId: string): Promise<void> {
    this.managedBy.set(undefined);
    this.certificate.enable();
    try {
      const ownership = await this.ownership.get('KeyChain', keyId);
      if (keyId !== this.keyChain.id || ownership?.ownership !== 'file-managed') return;
      this.managedBy.set(ownership.source || 'a configuration file');
      this.certificate.disable();
    } catch (error) {
      console.error('Ownership lookup failed:', error);
    }
  }

  async createCsr(): Promise<void> {
    if (this.creatingCsr()) return;
    const keyId = this.keyChain.id;
    this.creatingCsr.set(true);
    this.csrError.set('');
    try {
      const csr = await this.keyChainService.createCsr(keyId, this.subject.value.trim());
      if (keyId !== this.keyChain.id) return;
      this.csr.set(csr);
      afterNextRender(() => this.csrText?.nativeElement.focus(), { injector: this.injector });
    } catch (error) {
      console.error('CSR error:', error);
      if (keyId === this.keyChain.id) {
        this.csrError.set(getApiErrorMessage(error, 'Failed to create the CSR'));
      }
    } finally {
      this.creatingCsr.set(false);
    }
  }

  copyCsr(): void {
    navigator.clipboard
      .writeText(this.csr())
      .then(() => this.snackBar.open('CSR copied to clipboard', 'Close', { duration: 2000 }))
      .catch(() => this.snackBar.open('Failed to copy the CSR', 'Close', { duration: 2000 }));
  }

  downloadCsr(): void {
    const blob = new Blob([this.csr()], { type: 'application/pkcs10' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.keyChain.id}.csr`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async onCertificateFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    this.certificate.setValue(await readCertificateFiles(input.files));
    // Read after the change event's check, so Store Certificate is checked again.
    this.changeDetector.markForCheck();
    // The same file can be chosen again after the field was edited.
    input.value = '';
  }

  /**
   * What to confirm before the certificate is stored: replacing a
   * certificate issued by someone else, such as a registrar certificate.
   * Undefined when the key only has its self-signed certificate.
   */
  private replaceQuestion(): string | undefined {
    const active = this.keyChain.activeCertificate;
    if (!active || active.issuer === active.subject) return undefined;
    return `This replaces the active certificate issued by "${active.issuer}". The key stays the same, but the current certificate is no longer used. This cannot be undone.\n\nStore the new certificate?`;
  }

  async saveCertificate(): Promise<void> {
    const pem = this.certificate.value.trim();
    if (this.saving() || !pem || this.managedBy()) return;
    const question = this.replaceQuestion();
    if (question && !confirm(question)) return;

    const keyId = this.keyChain.id;
    this.saving.set(true);
    this.saveError.set('');
    try {
      await this.keyChainService.update(keyId, { activeCertificate: pem });
      if (keyId !== this.keyChain.id) return;
      this.certificate.reset('');
      this.csr.set('');
      this.snackBar.open('Certificate stored for this key', 'Close', { duration: 3000 });
      this.certificateSaved.emit();
    } catch (error) {
      console.error('Certificate save error:', error);
      if (keyId === this.keyChain.id) {
        this.saveError.set(getApiErrorMessage(error, 'Failed to store the certificate'));
      }
    } finally {
      this.saving.set(false);
    }
  }
}
