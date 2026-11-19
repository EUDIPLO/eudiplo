import { Component, Input, ChangeDetectionStrategy, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Router, RouterModule } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  clientControllerGetClients,
  ClientEntity,
  clientControllerDeleteClient,
  clientControllerRotateClientSecret,
} from '@eudiplo/sdk-core';
import { ApiService } from '../../../core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SecretDialogComponent } from '../secret-dialog/secret-dialog.component';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { JwtService } from '../../../services/jwt.service';
import { canManageRoles } from '../../../services/role-grants';
import { apiErrorDetail, getApiErrorMessage, hasHttpStatus } from '../../../utils/error-message';
import { clientDeleteConfirmation } from '../client-delete-confirmation';
import { clientRotateConfirmation } from '../client-rotate-confirmation';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { UnavailableCardComponent } from '../../../common/unavailable-card.component';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { FrontendConfigService } from '../../../services/frontend-config.service';
import { BaseAsyncListComponent } from '../../../common/base-async-list.component';
import { uniqueRoles } from '../../../services/role-groups';
import { ItemRoutePipe } from '../../../common/item-route.pipe';

/** Columns of the client table. */
type ClientColumn = 'clientId' | 'roles' | 'actions';

@Component({
  selector: 'app-client-list',
  imports: [
    ItemRoutePipe,
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    RouterModule,
    NgTemplateOutlet,
    FormsModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatDialogModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
    UnavailableCardComponent,
  ],
  templateUrl: './client-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './client-list.component.scss',
})
export class ClientListComponent extends BaseAsyncListComponent<ClientEntity> {
  protected readonly loadFailedMessage = 'Failed to load clients';
  protected override readonly rowLinkSelector = 'a.client-link';

  @Input() loadedClients?: ClientEntity[];
  /** Shown inside another page's card, such as a tenant's: without heading, search and card. */
  @Input() embedded = false;

  /** Roles a row shows before "+N more". */
  readonly visibleRoleCount = 4;

  /** The client column also shows the description. */
  displayedColumns: ClientColumn[] = ['clientId', 'roles', 'actions'];

  /** With another identity provider, records left from an earlier mode get no new secrets. */
  get rotatesSecrets(): boolean {
    return this.frontendConfig.authMode !== 'generic';
  }

  /** A tenant's records without an action to offer get no Actions column. */
  get columns(): ClientColumn[] {
    return this.loadedClients && !this.rotatesSecrets
      ? this.displayedColumns.filter((column) => column !== 'actions')
      : this.displayedColumns;
  }

  get clients(): ClientEntity[] {
    return this.items;
  }

  /** Text to find in a client's ID, description or roles. */
  protected override searchTexts(client: ClientEntity): string[] {
    return [client.clientId, client.description ?? '', ...(client.roles ?? [])];
  }

  protected override sortName(client: ClientEntity): string {
    return client.clientId;
  }

  /** A client's roles without repeats, as stored records may name a role twice. */
  uniqueRoles(client: ClientEntity): string[] {
    return uniqueRoles(client.roles);
  }

  readonly manageDeniedHint = 'This client has roles you neither hold nor may grant';
  /** Roles of the signed-in caller, read once instead of per row */
  private readonly callerRoles: string[];
  /** Tenant of the signed-in caller, read for the tenant page's clients. */
  private callerTenantId: string | null = null;
  private readonly frontendConfig = inject(FrontendConfigService);

  constructor(
    private readonly apiService: ApiService,
    private readonly router: Router,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService
  ) {
    super();
    this.callerRoles = jwtService.getRoles();
  }

  /** Whether the signed-in caller may edit, delete or rotate the secret of the client. */
  canManage(client: ClientEntity): boolean {
    return canManageRoles(this.callerRoles, client.roles ?? []);
  }
  /**
   * The client to look up for the Config Portability lock, or none. The lookup
   * only answers for the caller's own tenant, and refuses a caller without
   * one, so the tenant page asks only about clients of the caller's tenant.
   */
  ownershipId(client: ClientEntity): string {
    if (!this.loadedClients) return client.clientId;
    return this.callerTenantId && client.tenantId === this.callerTenantId ? client.clientId : '';
  }

  override ngOnInit(): void {
    if (this.loadedClients) {
      this.callerTenantId = this.jwtService.getTenantId();
      this.items = this.loadedClients;
      this.loading = false;
    } else {
      super.ngOnInit();
    }
  }

  protected fetchItems(): Promise<ClientEntity[]> {
    return clientControllerGetClients<true>().then((res) => res.data);
  }

  protected override unavailableReason(error: unknown): string | undefined {
    if (!hasHttpStatus(error, 501)) return undefined;
    return apiErrorDetail(error) ?? 'This instance does not manage API clients.';
  }

  async deleteClient(client: ClientEntity): Promise<void> {
    // Delete stays focusable while it waits or is refused (disabledInteractive).
    if (!client.clientId || !this.canManage(client)) {
      return;
    }
    const ownClient = client.clientId === this.apiService.getClientId();
    const deleted = await this.deleteItem({
      item: client,
      id: client.clientId,
      question: clientDeleteConfirmation(client.clientId, this.apiService.getClientId()),
      request: () => clientControllerDeleteClient({ path: { id: client.clientId } }),
      deleted: ownClient
        ? 'Client deleted. You have been signed out.'
        : 'Client deleted successfully',
      failed: 'Failed to delete client',
    });
    if (deleted && ownClient) {
      // The deleted client can no longer renew this session.
      this.apiService.logout();
      await this.router.navigate(['/login']);
    }
  }

  /**
   * Rotate (regenerate) a client's secret.
   * Shows the new secret in a dialog for one-time viewing.
   */
  async rotateSecret(client: ClientEntity): Promise<void> {
    if (!confirm(clientRotateConfirmation(client.clientId, this.apiService.getClientId()))) {
      return;
    }

    try {
      const result = await clientControllerRotateClientSecret({
        path: { id: client.clientId },
      });

      if (result.data?.secret) {
        this.dialog.open(SecretDialogComponent, {
          data: {
            clientId: client.clientId,
            secret: result.data.secret,
            apiUrl: this.apiService.getBaseUrl(),
          },
          width: '500px',
          disableClose: true,
        });
        if (client.clientId === this.apiService.getClientId()) {
          await this.continueWithSecret(result.data.secret);
        }
      }
    } catch (error) {
      console.error('Error rotating secret:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to rotate client secret'));
    }
  }

  /** The backend refuses the old secret's tokens, so the own session moves to the new secret. */
  private async continueWithSecret(secret: string): Promise<void> {
    try {
      await this.apiService.useRotatedSecret(secret);
    } catch (error) {
      console.error('Error continuing the session with the new secret:', error);
      openErrorSnackBar(
        this.snackBar,
        'Your session could not continue with the new secret. Save it, then log in again with it.'
      );
    }
  }
}
