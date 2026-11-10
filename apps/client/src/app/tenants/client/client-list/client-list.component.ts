import { Component, Input, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  clientControllerGetClients,
  ClientEntity,
  clientControllerDeleteClient,
  clientControllerRotateClientSecret,
} from '@eudiplo/sdk-core';
import { ApiService } from '../../../core';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SecretDialogComponent } from '../secret-dialog/secret-dialog.component';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { JwtService } from '../../../services/jwt.service';
import { canManageRoles } from '../../../services/role-grants';
import { apiErrorDetail, getApiErrorMessage, hasHttpStatus } from '../../../utils/error-message';
import { clientDeleteConfirmation } from '../client-delete-confirmation';
import { clientRotateConfirmation } from '../client-rotate-confirmation';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { LoadErrorComponent } from '../../../common/load-error.component';

@Component({
  selector: 'app-client-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    RouterModule,
    FlexLayoutModule,
    MatChipsModule,
    MatTooltipModule,
    MatDialogModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
  ],
  templateUrl: './client-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './client-list.component.scss',
})
export class ClientListComponent implements OnInit {
  @Input() loadedClients?: ClientEntity[];

  clients: ClientEntity[] = [];
  loading = false;
  /** Set when the list could not be loaded, so it is not shown as empty. */
  loadError = '';
  /** Why this instance manages no clients, for example because the identity provider does. */
  unavailableMessage = '';
  hasPermission = false;

  displayedColumns: (keyof ClientEntity | 'actions')[] = [
    'clientId',
    'description',
    'roles',
    'actions',
  ];

  readonly manageDeniedHint = 'This client has roles you neither hold nor may grant';
  /** Roles of the signed-in caller, read once instead of per row */
  private readonly callerRoles: string[];

  constructor(
    private readonly snackBar: MatSnackBar,
    private readonly apiService: ApiService,
    private readonly router: Router,
    private readonly dialog: MatDialog,
    jwtService: JwtService
  ) {
    this.callerRoles = jwtService.getRoles();
  }

  /** Whether the signed-in caller may edit, delete or rotate the secret of the client. */
  canManage(client: ClientEntity): boolean {
    return canManageRoles(this.callerRoles, client.roles ?? []);
  }
  ngOnInit(): void {
    if (this.loadedClients) {
      this.clients = this.loadedClients;
    } else {
      void this.loadClients();
    }
  }

  async loadClients(): Promise<void> {
    this.loading = true;
    this.loadError = '';
    this.unavailableMessage = '';
    try {
      this.clients = await clientControllerGetClients<true>().then((res) => res.data);
    } catch (error) {
      if (hasHttpStatus(error, 501)) {
        this.unavailableMessage =
          apiErrorDetail(error) ?? 'This instance does not manage API clients.';
        return;
      }
      console.error('Error loading clients:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load clients');
    } finally {
      this.loading = false;
    }
  }

  async deleteClient(client: ClientEntity): Promise<void> {
    if (
      !client.clientId ||
      !confirm(clientDeleteConfirmation(client.clientId, this.apiService.getClientId()))
    ) {
      return;
    }

    try {
      await clientControllerDeleteClient({ path: { id: client.clientId } });
    } catch (error) {
      console.error('Error deleting client:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete client'));
      return;
    }

    if (client.clientId === this.apiService.getClientId()) {
      // The deleted client can no longer renew this session.
      this.apiService.logout();
      this.snackBar.open('Client deleted. You have been signed out.', 'Close', { duration: 5000 });
      await this.router.navigate(['/login']);
      return;
    }
    await this.loadClients(); // Reload the list
    this.snackBar.open('Client deleted successfully', 'Close', { duration: 3000 });
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
