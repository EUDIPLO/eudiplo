import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage, hasHttpStatus } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import {
  type FederationTrustAnchor,
  FederationTrustAnchorService,
} from '../federation-trust-anchor.service';
import { FederationTrustAnchorReferences } from '../federation-trust-anchor-references';

/** The members of a pinned key the page lists; the full key is in the JWK set below. */
interface PinnedKey {
  kid: string;
  kty: string;
  crv?: string;
  alg?: string;
  use?: string;
}

@Component({
  selector: 'app-federation-trust-anchor-show',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatSnackBarModule,
    MatTableModule,
    MatTooltipModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './federation-trust-anchor-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './federation-trust-anchor-show.component.scss',
  providers: [FederationTrustAnchorReferences],
})
export class FederationTrustAnchorShowComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly service = inject(FederationTrustAnchorService);
  readonly references = inject(FederationTrustAnchorReferences);
  private readonly configDocuments = inject(ConfigDocumentService);
  private readonly injector = inject(Injector);

  @ViewChild('pageHeading', { read: ElementRef })
  private readonly pageHeading?: ElementRef<HTMLElement>;

  readonly keyColumns = ['kid', 'kty', 'crv', 'alg', 'use'];
  readonly id = this.route.snapshot.paramMap.get('id')!;
  anchor?: FederationTrustAnchor;
  keys: PinnedKey[] = [];
  jwksJson = '';
  /** Set when the trust anchor could not be loaded, so the page is not left blank. */
  loadError = '';
  /** True while a delete request runs, so it is not sent twice. */
  deleting = false;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const retrying = this.loadError !== '';
    this.loadError = '';
    try {
      const anchor = await this.service.getById(this.id);
      this.anchor = anchor;
      const keys = (anchor.jwks as { keys?: PinnedKey[] }).keys;
      this.keys = Array.isArray(keys) ? keys : [];
      this.jwksJson = JSON.stringify(anchor.jwks, null, 2);
      // The retry removed the error card with its focused Retry button.
      if (retrying) focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
      await this.references.load(anchor.entityId);
    } catch (error) {
      if (!this.anchor) this.loadError = getApiErrorMessage(error, 'Failed to load trust anchor');
    }
  }

  /** The trust anchor as messages name it: its description and ID, or its ID alone. */
  private anchorName(): string {
    const description = this.anchor?.description;
    return description ? `"${description}" (${this.id})` : `"${this.id}"`;
  }

  /**
   * Why the backend would refuse the delete, when this page already sees configurations that
   * name the trust anchor's entity ID; undefined otherwise.
   */
  deleteBlockedReason(): string | undefined {
    const uses = this.references.describe();
    if (!uses) return undefined;
    return (
      `Trust anchor ${this.anchorName()} is still named by ${uses}.` +
      ' Remove these references before deleting it.'
    );
  }

  /**
   * Asks before deleting a trust anchor that this page sees no references to. References it
   * cannot see, not readable with the caller's roles, make the backend refuse the delete and
   * name them.
   */
  deleteQuestion(): string {
    return (
      `Delete trust anchor ${this.anchorName()}? If a configuration names its entity ID, the` +
      ' delete is refused and the configurations are named. This cannot be undone.'
    );
  }

  async delete(): Promise<void> {
    // Whether the delete is blocked depends on the references, so it waits until they are known.
    if (this.deleting || this.references.loading) return;
    const blocked = this.deleteBlockedReason();
    if (blocked) {
      openErrorSnackBar(this.snackBar, blocked);
      return;
    }
    if (!confirm(this.deleteQuestion())) return;
    this.deleting = true;
    try {
      await this.service.delete(this.id);
      this.snackBar.open('Trust anchor deleted', 'Close', { duration: 3000 });
      await this.router.navigate(['/federation-trust-anchor']);
    } catch (error) {
      this.deleting = false;
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Error deleting trust anchor'));
      // The backend found references this page did not show; show its current state.
      if (hasHttpStatus(error, 409) && this.anchor) void this.references.load(this.anchor.entityId);
    }
  }

  async copyEntityId(entityId: string): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      entityId,
      'Entity ID copied to clipboard',
      'Could not copy the entity ID. Select it in the Entity ID row and copy it by hand.'
    );
  }

  async copyJwks(): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      this.jwksJson,
      'JWK set copied to clipboard',
      'Could not copy the JWK set. Select it below the Copy button and copy it by hand.'
    );
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return this.configDocuments.isDownloading('FederationTrustAnchor', this.id);
  }

  async download(): Promise<void> {
    await this.configDocuments.downloadWithFeedback('FederationTrustAnchor', this.id);
  }
}
