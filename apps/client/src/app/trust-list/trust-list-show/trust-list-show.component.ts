import { CommonModule, DatePipe } from '@angular/common';
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
import { MatChipsModule } from '@angular/material/chips';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  CredentialConfig,
  PresentationConfig,
  TrustList,
  TrustListVersion,
  trustListControllerDeleteTrustList,
  trustListControllerGetTrustList,
  trustListControllerGetTrustListVersions,
} from '@eudiplo/sdk-core';
import { ApiService } from '../../core';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { FrontendConfigService } from '../../services/frontend-config.service';
import { JwtService } from '../../services/jwt.service';
import { trustListUrl } from '../../utils/public-url';
import { getApiErrorMessage, hasHttpStatus } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import {
  credentialConfigReferencesTrustList,
  presentationConfigReferencesTrustList,
} from '../trust-list-reference';

interface EntityInfo {
  name: string;
  lang?: string;
  uri?: string;
  country?: string;
  locality?: string;
  postalCode?: string;
  streetAddress?: string;
  contactUri?: string;
}

interface InternalEntity {
  type: 'internal';
  issuerKeyChainId: string;
  revocationKeyChainId: string;
  info: EntityInfo;
}

interface ExternalEntity {
  type: 'external';
  issuerCertPem: string;
  revocationCertPem: string;
  info: EntityInfo;
}

type TrustListEntity = InternalEntity | ExternalEntity;

@Component({
  selector: 'app-trust-list-show',
  imports: [
    CommonModule,
    DatePipe,
    MatSnackBarModule,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTabsModule,
    MatTooltipModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './trust-list-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './trust-list-show.component.scss',
})
export class TrustListShowComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly apiService = inject(ApiService);
  private readonly credentialConfigService = inject(CredentialConfigService);
  private readonly presentationService = inject(PresentationManagementService);
  private readonly frontendConfigService = inject(FrontendConfigService);
  private readonly jwtService = inject(JwtService);
  private readonly configDocuments = inject(ConfigDocumentService);
  private readonly injector = inject(Injector);

  @ViewChild('pageHeading', { read: ElementRef })
  private readonly pageHeading?: ElementRef<HTMLElement>;

  trustList?: TrustList;
  entities: TrustListEntity[] = [];
  versions: TrustListVersion[] = [];
  publicUrl = '';
  /**
   * True when the backend did not report its public URL and publicUrl uses the instance URL
   * the admin signed in with instead, which wallets may not reach.
   */
  publicUrlIsInstanceUrl = false;
  relatedCredentialConfigs: CredentialConfig[] = [];
  relatedCredentialConfigsLoading = false;
  relatedCredentialConfigsFailed = false;
  relatedPresentationConfigs: PresentationConfig[] = [];
  relatedPresentationConfigsLoading = false;
  relatedPresentationConfigsFailed = false;
  /** Set when the list could not be loaded, so the page is not left blank. */
  loadError = '';
  /** True while a delete request runs, so it is not sent twice. */
  deleting = false;
  private readonly id: string;

  constructor() {
    this.id = this.route.snapshot.paramMap.get('id')!;
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    const retrying = this.loadError !== '';
    this.loadError = '';
    trustListControllerGetTrustList({ path: { id: this.id } }).then(
      async (res) => {
        this.trustList = res.data;
        // The retry removed the error card with its focused Retry button.
        if (retrying) {
          focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
        }
        this.parseEntities();
        this.loadVersions(this.id);
        void this.buildPublicUrl();
        await Promise.all([
          this.loadRelatedCredentialConfigs(),
          this.loadRelatedPresentationConfigs(),
        ]);
      },
      (error) => {
        this.loadError = getApiErrorMessage(error, 'Failed to load trust list');
      }
    );
  }

  private parseEntities(): void {
    if (this.trustList?.entityConfig) {
      this.entities = this.trustList.entityConfig as unknown as TrustListEntity[];
    }
  }

  private loadVersions(id: string): void {
    trustListControllerGetTrustListVersions({ path: { id } }).then(
      (res) => {
        this.versions = res.data ?? [];
      },
      () => {
        // Version history not critical, just log
        console.warn('Could not load version history');
      }
    );
  }

  isInternalEntity(entity: TrustListEntity): entity is InternalEntity {
    return entity.type === 'internal';
  }

  isExternalEntity(entity: TrustListEntity): entity is ExternalEntity {
    return entity.type === 'external';
  }

  getTrustedEntitiesCount(): number {
    const data = this.trustList?.data as { LoTE?: { TrustedEntitiesList?: unknown[] } } | undefined;
    return data?.LoTE?.TrustedEntitiesList?.length ?? 0;
  }

  /**
   * Wallets fetch the list under the backend's PUBLIC_URL, not under the instance URL used to
   * sign in. Backends that do not report it get the instance URL with a warning.
   */
  private async buildPublicUrl(): Promise<void> {
    const trustList = this.trustList;
    if (!trustList) return;
    const publicUrl = (await this.frontendConfigService.getConfig())?.publicUrl;
    this.publicUrlIsInstanceUrl = !publicUrl;
    this.publicUrl = trustListUrl(
      publicUrl ?? this.apiService.getBaseUrl() ?? '',
      trustList.tenantId,
      trustList.id
    );
  }

  /** Credential configs, and so their references to this list, need `issuance:manage`. */
  get canReadCredentialConfigs(): boolean {
    return this.jwtService.hasRole('issuance:manage');
  }

  private async loadRelatedCredentialConfigs(): Promise<void> {
    const trustList = this.trustList;
    if (!trustList || !this.canReadCredentialConfigs) return;

    this.relatedCredentialConfigsLoading = true;
    this.relatedCredentialConfigsFailed = false;
    try {
      const allConfigs = await this.credentialConfigService.loadConfigurations();
      this.relatedCredentialConfigs = allConfigs.filter((config) =>
        credentialConfigReferencesTrustList(config, trustList)
      );
    } catch {
      this.relatedCredentialConfigsFailed = true;
    } finally {
      this.relatedCredentialConfigsLoading = false;
    }
  }

  /** Presentation configs, and so their DCQL trust references, need a presentation role. */
  get canReadPresentationConfigs(): boolean {
    return this.jwtService.hasRole(['presentation:manage', 'presentation:request']);
  }

  private async loadRelatedPresentationConfigs(): Promise<void> {
    const trustList = this.trustList;
    if (!trustList || !this.canReadPresentationConfigs) return;

    this.relatedPresentationConfigsLoading = true;
    this.relatedPresentationConfigsFailed = false;
    try {
      const allConfigs = await this.presentationService.loadConfigurations();
      this.relatedPresentationConfigs = allConfigs.filter((config) =>
        presentationConfigReferencesTrustList(config, trustList)
      );
    } catch {
      this.relatedPresentationConfigsFailed = true;
    } finally {
      this.relatedPresentationConfigsLoading = false;
    }
  }

  /** The kinds of config that can reference the list, with what this page knows about them. */
  private referenceKinds() {
    return [
      {
        noun: 'credential config',
        count: this.relatedCredentialConfigs.length,
        known:
          this.canReadCredentialConfigs &&
          !this.relatedCredentialConfigsLoading &&
          !this.relatedCredentialConfigsFailed,
      },
      {
        noun: 'presentation config',
        count: this.relatedPresentationConfigs.length,
        known:
          this.canReadPresentationConfigs &&
          !this.relatedPresentationConfigsLoading &&
          !this.relatedPresentationConfigsFailed,
      },
    ];
  }

  /** The list as messages name it: its description and ID, or its ID alone. */
  private listName(): string {
    const description = this.trustList?.description;
    return description ? `"${description}" (${this.id})` : `"${this.id}"`;
  }

  /**
   * Why the backend would refuse the delete, when this page already sees configs that reference
   * the list; undefined otherwise.
   */
  deleteBlockedReason(): string | undefined {
    const used = this.referenceKinds().filter((kind) => kind.known && kind.count > 0);
    if (!used.length) return undefined;
    const counts = used.map((kind) => `${kind.count} ${kind.noun}${kind.count === 1 ? '' : 's'}`);
    return (
      `Trust list ${this.listName()} is still referenced by ${counts.join(' and ')}.` +
      ' Remove these references before deleting it.'
    );
  }

  /**
   * Asks before deleting a list that this page sees no references to. References it cannot see,
   * still loading, not readable with the caller's roles or in the issuance configuration, make
   * the backend refuse the delete and name them.
   */
  deleteQuestion(): string {
    return (
      `Delete trust list ${this.listName()}? If a configuration still references it, the delete` +
      ' is refused and the configurations are named. This cannot be undone.'
    );
  }

  async copyUrl(): Promise<void> {
    await copyToClipboard(
      this.snackBar,
      this.publicUrl,
      'Trust List URL copied to clipboard',
      'Could not copy the URL. Select it in the Trust List URL field and copy it by hand.'
    );
  }

  delete() {
    if (this.deleting) return;
    const blocked = this.deleteBlockedReason();
    if (blocked) {
      openErrorSnackBar(this.snackBar, blocked);
      return;
    }
    if (!confirm(this.deleteQuestion())) {
      return;
    }
    this.deleting = true;
    trustListControllerDeleteTrustList({ path: { id: this.id } }).then(
      () => {
        this.snackBar.open('Trust list deleted', 'Close', { duration: 3000 });
        this.router.navigate(['/trust-list']);
      },
      (error) => {
        this.deleting = false;
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Error deleting trust list'));
        // The backend found references this page did not show; show its current state.
        if (hasHttpStatus(error, 409)) {
          void this.loadRelatedCredentialConfigs();
          void this.loadRelatedPresentationConfigs();
        }
      }
    );
  }

  /** True while the configuration document is being downloaded. */
  get downloadingConfig(): boolean {
    return this.configDocuments.isDownloading('TrustList', this.id);
  }

  /**
   * Downloads the configuration as a document that the config folder and
   * configuration bundles import.
   */
  async download(): Promise<void> {
    await this.configDocuments.downloadWithFeedback('TrustList', this.id);
  }
}
