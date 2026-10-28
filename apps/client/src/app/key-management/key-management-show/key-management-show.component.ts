import { Component, type OnInit, type OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  KeyChainResponseDto,
  CertificateInfoDto,
  type DefaultAccessKeyChainDto,
} from '@eudiplo/sdk-core';
import { MatDialog } from '@angular/material/dialog';
import { keyChainDeleteQuestion } from '../key-chain-delete-question';
import {
  changeDefaultAccess,
  defaultAccessChip,
  defaultAccessDeleteRefusal,
  defaultAccessToggleLabel,
  defaultAccessToggleTooltip,
  isConfiguredDefaultAccess,
  loadDefaultAccess,
} from '../default-access-key-chain';
import { KeyChainService } from '../key-chain.service';
import { Subscription } from 'rxjs';
import { JsonViewDialogComponent } from '../../issuance/credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { KeyCertificateRequestComponent } from '../key-certificate-request/key-certificate-request.component';
import { JwtService } from '../../services/jwt.service';
import { RegistrarService, accessCertificateRefusal } from '../../registrar/registrar.service';
import { getApiErrorMessage, getHttpErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';

@Component({
  selector: 'app-key-management-show',
  imports: [
    CommonModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatChipsModule,
    MatListModule,
    MatTooltipModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
    KeyCertificateRequestComponent,
  ],
  templateUrl: './key-management-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './key-management-show.component.scss',
})
export class KeyManagementShowComponent implements OnInit, OnDestroy {
  keyChain?: KeyChainResponseDto;
  /** True while a delete request runs, so it is not sent twice. */
  deleting = false;
  /** Set when the key chain could not be loaded, instead of loading forever. */
  loadError = '';
  private requestedId = '';
  /**
   * The tenant's default access key chain, for an access key chain; undefined when it could
   * not be loaded, so the page neither marks the key chain nor offers to change the default.
   */
  defaultAccess?: DefaultAccessKeyChainDto;
  /** True while a request that changes the default access key chain runs. */
  updatingDefault = false;

  private routeSubscription?: Subscription;

  /**
   * Whether a registrar configuration exists. `unknown` when it could not be
   * read, which does not mean that it is missing.
   */
  registrarConfig: 'checking' | 'unknown' | 'configured' | 'missing' = 'checking';
  /** The key chain whose enrollment is running, so another key's page is not held up. */
  private enrollingKeyId?: string;

  get isEnrolling(): boolean {
    return !!this.enrollingKeyId && this.enrollingKeyId === this.keyChain?.id;
  }

  constructor(
    private readonly keyChainService: KeyChainService,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService,
    private readonly registrarService: RegistrarService,
    private readonly configDocuments: ConfigDocumentService
  ) {}

  ngOnInit(): void {
    if (this.canUseRegistrar) void this.checkRegistrarConfig();
    this.routeSubscription = this.route.paramMap.subscribe((params) => {
      const keyId = params.get('id');
      if (keyId) {
        this.loadKey(keyId);
      }
    });
  }

  ngOnDestroy(): void {
    this.routeSubscription?.unsubscribe();
  }

  private async loadKey(id: string): Promise<void> {
    this.requestedId = id;
    this.keyChain = undefined;
    this.loadError = '';

    this.defaultAccess = undefined;

    try {
      this.keyChain = await this.keyChainService.getById(id);
    } catch (error) {
      console.error('Load error:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load key chain');
      return;
    }
    await this.loadDefaultAccess(id);
  }

  /** Loads the default access key chain for an access key chain; the page works without it. */
  private async loadDefaultAccess(id: string): Promise<void> {
    if (this.keyChain?.usageType !== 'access') return;
    const info = await loadDefaultAccess(this.keyChainService, this.snackBar);
    if (id === this.requestedId) this.defaultAccess = info;
  }

  get defaultChip(): { label: string; tooltip: string } | undefined {
    return defaultAccessChip(this.defaultAccess, this.keyId);
  }

  get isDefaultAccess(): boolean {
    return isConfiguredDefaultAccess(this.defaultAccess, this.keyId);
  }

  get defaultToggleTooltip(): string {
    return defaultAccessToggleTooltip(this.defaultAccess, this.keyId);
  }

  get defaultToggleLabel(): string {
    return defaultAccessToggleLabel(this.defaultAccess, this.keyId, this.description || this.keyId);
  }

  /** Makes this key chain the tenant's default access key chain, or removes it as default. */
  async toggleDefaultAccess(): Promise<void> {
    if (!this.keyChain || this.updatingDefault || !this.defaultAccess) return;
    const id = this.keyChain.id;

    this.updatingDefault = true;
    try {
      const info = await changeDefaultAccess(
        this.keyChainService,
        this.snackBar,
        this.isDefaultAccess ? null : id
      );
      if (info && id === this.requestedId) this.defaultAccess = info;
    } finally {
      this.updatingDefault = false;
    }
  }

  /**
   * Loads the key chain again while its page stays shown, so the focused
   * action keeps its focus. A failed load keeps the shown state, and so does
   * a load of a key the user has meanwhile navigated away from.
   */
  private async refreshKey(id: string): Promise<void> {
    if (id !== this.requestedId) return;
    try {
      const keyChain = await this.keyChainService.getById(id);
      if (id === this.requestedId) this.keyChain = keyChain;
    } catch (error) {
      console.error('Reload error:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to reload key chain'));
    }
  }

  /**
   * A standalone signing key can get its certificate from an external CA.
   * The tenant's encryption key chain is listed as standalone but signs
   * nothing, an internal chain's root CA issues its certificates, and a
   * federation key is published as a JWK without its certificate.
   */
  get offersCertificateRequest(): boolean {
    return (
      this.keyChain?.type === 'standalone' &&
      this.keyChain.usageType !== 'encrypt' &&
      !this.isFederationKey
    );
  }

  /** The key was created to request its certificate, so the steps are shown open. */
  get requestsCertificate(): boolean {
    return this.route.snapshot?.queryParamMap?.get('certificate') === 'request';
  }

  /** Shows the certificate an external CA issued, once it is stored. */
  onCertificateSaved(): void {
    if (this.requestsCertificate) {
      // The steps were opened for this certificate; a reload should not open them again.
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { certificate: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
    if (this.keyChain) void this.refreshKey(this.keyChain.id);
  }

  retryLoad(): void {
    void this.loadKey(this.requestedId);
  }

  get keyId(): string {
    return this.keyChain?.id || '';
  }

  get description(): string | undefined {
    return this.keyChain?.description;
  }

  get usageType(): string {
    return this.keyChain?.usageType || '';
  }

  /** Federation keys are published as a JWK; their certificate is not used. */
  get isFederationKey(): boolean {
    return this.usageType === 'federation';
  }

  get activePublicKeyJson(): string {
    return JSON.stringify(this.keyChain?.activePublicKey ?? {}, null, 2);
  }

  getTypeLabel(): string {
    if (!this.keyChain) return '';
    if (this.keyChain.type === 'internalChain') {
      return this.keyChain.rotationPolicy.enabled ? 'Internal Chain (Rotating)' : 'Internal Chain';
    }
    return this.keyChain.rotationPolicy.enabled ? 'Standalone (Rotating)' : 'Standalone';
  }

  getTypeIcon(): string {
    if (!this.keyChain) return 'key';
    if (this.keyChain.type === 'internalChain') {
      return 'account_tree';
    }
    return this.keyChain.rotationPolicy.enabled ? 'autorenew' : 'key';
  }

  getTypeDescription(): string {
    if (!this.keyChain) return '';
    if (this.keyChain.type === 'internalChain') {
      return 'This key chain has an embedded Root CA that signs the active key certificate.';
    }
    if (this.isFederationKey) {
      return 'This is a standalone key, published as a JWK in the OpenID Federation entity configuration.';
    }
    if (!this.keyChain.activeCertificate) return 'This is a standalone key.';
    return this.isSelfSigned()
      ? 'This is a self-signed standalone key.'
      : 'This is a standalone key; its Active Certificate was issued by the Issuer shown there.';
  }

  /** A certificate whose issuer is its subject signed itself. */
  private isSelfSigned(): boolean {
    const certificate = this.keyChain?.activeCertificate;
    return !!certificate && certificate.issuer === certificate.subject;
  }

  hasRootCa(): boolean {
    return this.keyChain?.type === 'internalChain' && !!this.keyChain.rootCertificate;
  }

  hasPreviousKey(): boolean {
    return !!this.keyChain?.previousCertificate;
  }

  copyPublicKeyToClipboard(jwk: object): void {
    navigator.clipboard
      .writeText(JSON.stringify(jwk, null, 2))
      .then(() => {
        this.snackBar.open('Public key (JWK) copied to clipboard', 'Close', { duration: 2000 });
      })
      .catch(() => {
        this.snackBar.open('Failed to copy public key', 'Close', { duration: 2000 });
      });
  }

  copyCertificateToClipboard(cert: CertificateInfoDto): void {
    navigator.clipboard
      .writeText(cert.pem)
      .then(() => {
        this.snackBar.open('Certificate copied to clipboard', 'Close', { duration: 2000 });
      })
      .catch(() => {
        this.snackBar.open('Failed to copy certificate', 'Close', { duration: 2000 });
      });
  }

  formatDate(dateString: string): string {
    return new Date(dateString).toLocaleString();
  }

  isCertExpired(cert: CertificateInfoDto): boolean {
    if (!cert.notAfter) return false;
    return new Date(cert.notAfter) < new Date();
  }

  async deleteKey(): Promise<void> {
    const keyChain = this.keyChain;
    if (!keyChain || this.deleting) return;
    // The backend refuses it; say so instead of asking first.
    const refusal = defaultAccessDeleteRefusal(this.defaultAccess, keyChain.id);
    if (refusal) {
      openErrorSnackBar(this.snackBar, refusal);
      return;
    }
    const consequence =
      keyChain.usageType === 'federation'
        ? ' If this key signs your OpenID Federation entity configuration, the entity is no longer trusted until your trust anchor lists the public key of a replacement federation key (and federation.entityKeyChainId, if set, names it).'
        : '';
    if (!confirm(keyChainDeleteQuestion(keyChain.id, this.description) + consequence)) {
      return;
    }

    this.deleting = true;
    try {
      await this.keyChainService.delete(keyChain.id);
      this.snackBar.open('Key chain deleted successfully', 'Close', { duration: 3000 });
      this.router.navigate(['../'], { relativeTo: this.route });
    } catch (error) {
      // On a 409 the backend names the configurations that still use the key chain.
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete key chain'));
      console.error('Delete error:', error);
    } finally {
      this.deleting = false;
    }
  }

  async rotateKey(): Promise<void> {
    if (!this.keyChain) return;

    if (!confirm('Rotate this key chain? The current key will move to the previous slot.')) {
      return;
    }

    try {
      await this.keyChainService.rotate(this.keyChain.id);
      this.snackBar.open('Key chain rotated successfully', 'Close', { duration: 3000 });
      await this.loadKey(this.keyChain.id);
    } catch (error) {
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to rotate key chain'));
      console.error('Rotate error:', error);
    }
  }

  /** Reading the registrar configuration and enrolling through it need registrar:manage. */
  private get canUseRegistrar(): boolean {
    return this.jwtService.hasRole('registrar:manage');
  }

  /**
   * Only a standalone access key chain can be enrolled with the registrar,
   * and only when a registrar configuration exists. One that could not be
   * read keeps the action; the enrollment then says what failed.
   */
  get canEnrollWithRegistrar(): boolean {
    return (
      this.isEnrollableKey &&
      (this.registrarConfig === 'configured' || this.registrarConfig === 'unknown')
    );
  }

  /** The enrollment would be offered once a registrar configuration exists. */
  get needsRegistrarConfig(): boolean {
    return this.isEnrollableKey && this.registrarConfig === 'missing';
  }

  private get isEnrollableKey(): boolean {
    return (
      this.canUseRegistrar &&
      this.keyChain?.type === 'standalone' &&
      this.keyChain.usageType === 'access'
    );
  }

  private async checkRegistrarConfig(): Promise<void> {
    try {
      const config = await this.registrarService.getConfig();
      this.registrarConfig = config ? 'configured' : 'missing';
    } catch (error) {
      console.error('Registrar configuration check failed:', error);
      this.registrarConfig = 'unknown';
    }
  }

  /**
   * What to confirm before an enrollment: replacing a certificate issued by
   * someone else, and enrolling a rotating key, whose next rotation replaces
   * the registrar certificate with a self-signed one. Undefined when nothing.
   */
  private enrollmentQuestion(): string | undefined {
    const certificate = this.keyChain?.activeCertificate;
    const parts: string[] = [];
    if (certificate && !this.isSelfSigned()) {
      parts.push(
        `This replaces the active certificate issued by "${certificate.issuer}" with a new certificate from the registrar. The key stays the same, but the current certificate is no longer used. This cannot be undone.`
      );
    }
    if (this.keyChain?.rotationPolicy?.enabled) {
      parts.push(
        'This key rotates automatically: its next rotation replaces the registrar certificate with a self-signed one for a new key. Turn rotation off by editing the key chain to keep the registrar certificate.'
      );
    }
    return parts.length ? `${parts.join('\n\n')}\n\nEnroll with the registrar?` : undefined;
  }

  /**
   * Requests a certificate for the key from the registrar, which replaces its
   * active certificate. A certificate issued by someone else, such as an
   * earlier registrar certificate, is only replaced after confirmation.
   */
  async enrollWithRegistrar(): Promise<void> {
    if (!this.keyChain || this.enrollingKeyId === this.keyChain.id) return;
    const question = this.enrollmentQuestion();
    if (question && !confirm(question)) return;

    const keyId = this.keyChain.id;
    this.enrollingKeyId = keyId;
    try {
      await this.registrarService.createAccessCertificate(keyId);
      this.snackBar.open('Access certificate enrolled via registrar', 'Close', { duration: 3000 });
      await this.refreshKey(keyId);
    } catch (error) {
      console.error('Enroll error:', error);
      // Names an unreachable backend separately from a registrar failure.
      const message = getHttpErrorMessage(error, 'Failed to enroll certificate from registrar');
      const refusal = accessCertificateRefusal(error);
      if (refusal === 'role') {
        openErrorSnackBar(this.snackBar, message);
      } else {
        openErrorSnackBar(this.snackBar, message, 'Go to Registrar')
          .onAction()
          .subscribe(() => this.router.navigate(['/registrar']));
      }
      // Without a refusal the certificate may have been stored; show what the key holds now.
      if (!refusal) await this.refreshKey(keyId);
    } finally {
      if (this.enrollingKeyId === keyId) this.enrollingKeyId = undefined;
    }
  }

  get canRotate(): boolean {
    return this.keyChain?.rotationPolicy?.enabled || false;
  }

  /**
   * Show the key chain as JSON. Uses the public representation so that no
   * private key material is rendered on screen.
   */
  viewAsJson(): void {
    if (!this.keyChain) return;

    this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: 'Key Chain JSON',
        jsonData: this.keyChain,
        readonly: true,
      },
      disableClose: false,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });
  }

  /**
   * The document carries the private keys of keys held in the database, which
   * the backend only hands to tenant administrators.
   */
  get canDownloadConfig(): boolean {
    return this.configDocuments.canDownload('KeyChain');
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return !!this.keyChain && this.configDocuments.isDownloading('KeyChain', this.keyChain.id);
  }

  /**
   * Downloads the key chain as a document that the config folder and
   * configuration bundles import.
   */
  async downloadConfig(): Promise<void> {
    if (!this.keyChain) return;
    await this.configDocuments.downloadWithFeedback('KeyChain', this.keyChain.id);
  }
}
