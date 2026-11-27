import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import {
  type FederationTrustAnchor,
  FederationTrustAnchorService,
} from '../federation-trust-anchor.service';
import { ItemRoutePipe } from '../../common/item-route.pipe';
import { RoleLockDirective } from '../../common/role-lock.directive';
import { SHARED_WRITE_ROLES } from '../../services/resource-roles';

@Component({
  selector: 'app-federation-trust-anchor-list',
  imports: [
    ItemRoutePipe,
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    RouterModule,
    MatCardModule,
    ConfigOwnershipDirective,
    RoleLockDirective,
    LoadErrorComponent,
  ],
  templateUrl: './federation-trust-anchor-list.component.html',
  styleUrl: './federation-trust-anchor-list.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class FederationTrustAnchorListComponent extends BaseAsyncListComponent<FederationTrustAnchor> {
  /** Creating, changing and deleting it needs issuance:manage or presentation:manage; reading needs less. */
  readonly writeRoles = SHARED_WRITE_ROLES;

  protected readonly loadFailedMessage = 'Failed to load federation trust anchors';

  readonly displayedColumns = ['id', 'entityId', 'description', 'keys', 'actions'];

  constructor(
    private readonly service: FederationTrustAnchorService,
    protected readonly configDocuments: ConfigDocumentService
  ) {
    super();
  }

  get anchors(): FederationTrustAnchor[] {
    return this.items;
  }

  protected fetchItems(): Promise<FederationTrustAnchor[]> {
    return this.service.getAll();
  }

  keyCount(anchor: FederationTrustAnchor): number {
    const keys = (anchor.jwks as { keys?: unknown[] }).keys;
    return Array.isArray(keys) ? keys.length : 0;
  }

  async downloadConfig(anchor: FederationTrustAnchor): Promise<void> {
    await this.configDocuments.downloadWithFeedback('FederationTrustAnchor', anchor.id);
  }
}
