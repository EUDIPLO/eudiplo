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
import { KeyChainResponseDto, CertificateInfoDto } from '@eudiplo/sdk-core';
import { MatDialog } from '@angular/material/dialog';
import {
  KEY_ADMIN_FORBIDDEN_MESSAGE,
  KEY_ADMIN_ROLES,
  KeyChainService,
  isForbidden,
} from '../key-chain.service';
import { Subscription } from 'rxjs';
import { JsonViewDialogComponent } from '../../issuance/credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { JwtService } from '../../services/jwt.service';

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
  ],
  templateUrl: './key-management-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './key-management-show.component.scss',
})
export class KeyManagementShowComponent implements OnInit, OnDestroy {
  keyChain?: KeyChainResponseDto;

  private routeSubscription?: Subscription;

  constructor(
    private readonly keyChainService: KeyChainService,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService
  ) {}

  ngOnInit(): void {
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
    this.keyChain = undefined;

    try {
      this.keyChain = await this.keyChainService.getById(id);
    } catch (error) {
      this.snackBar.open('Failed to load key chain', 'Close', { duration: 3000 });
      console.error('Load error:', error);
    }
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
    return 'This is a self-signed standalone key.';
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
    const displayName = this.description || this.keyId;
    if (!confirm(`Delete key chain "${displayName}"? This cannot be undone.`)) {
      return;
    }

    try {
      if (this.keyChain) {
        await this.keyChainService.delete(this.keyChain.id);
      }
      this.snackBar.open('Key chain deleted successfully', 'Close', { duration: 3000 });
      this.router.navigate(['../'], { relativeTo: this.route });
    } catch (error) {
      this.snackBar.open('Failed to delete key chain', 'Close', { duration: 3000 });
      console.error('Delete error:', error);
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
      this.snackBar.open('Failed to rotate key chain', 'Close', { duration: 3000 });
      console.error('Rotate error:', error);
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
   * Exporting returns private key material, which the backend only allows for
   * tenant administrators.
   */
  get canExport(): boolean {
    return this.jwtService.hasRole(KEY_ADMIN_ROLES);
  }

  async exportKeyChain(): Promise<void> {
    if (!this.keyChain) return;
    if (!this.canExport) {
      this.showExportForbidden();
      return;
    }

    try {
      const exportData = await this.keyChainService.export(this.keyChain.id);
      const json = JSON.stringify(exportData, null, 4);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.keyChain.usageType}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.snackBar.open('Key chain exported', 'Close', { duration: 3000 });
    } catch (error) {
      if (isForbidden(error)) {
        this.showExportForbidden();
        return;
      }
      this.snackBar.open('Failed to export key chain', 'Close', { duration: 3000 });
      console.error('Export error:', error);
    }
  }

  private showExportForbidden(): void {
    this.snackBar.open(KEY_ADMIN_FORBIDDEN_MESSAGE, 'Close', { duration: 5000 });
  }
}
