import { Component, OnInit, ChangeDetectionStrategy, DestroyRef } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import type { ClientEntity } from '@eudiplo/sdk-core';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { JwtService } from '../../../services/jwt.service';
import { roleChoices } from '../../../services/role-grants';
import { RoleLockNoticeComponent } from '../../../common/role-lock-notice.component';
import { getApiErrorMessage } from '../../../utils/error-message';
import { ApiService } from '../../../core';
import { clientDeleteConfirmation } from '../client-delete-confirmation';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import { copyToClipboard } from '../../../utils/copy-to-clipboard';
import { ApiClientService } from '../api-client.service';
import { groupRoles, type RoleGroup, uniqueRoles } from '../../../services/role-groups';

@Component({
  selector: 'app-client-show',
  imports: [
    MatSnackBarModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    RouterModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    RoleLockNoticeComponent,
  ],
  templateUrl: './client-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './client-show.component.scss',
})
export class ClientShowComponent implements OnInit {
  client?: ClientEntity;
  /** True while the delete request runs and, once it succeeded, until the page is left; disables Edit and Delete. */
  deleting = false;
  constructor(
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly jwtService: JwtService,
    private readonly apiService: ApiService,
    private readonly destroyRef: DestroyRef,
    private readonly clientService: ApiClientService
  ) {}

  /** Roles of the client that keep the signed-in caller from editing or deleting it */
  get unmanageableRoles(): string[] {
    return roleChoices(this.jwtService.getRoles(), this.client?.roles ?? []).unmanageable;
  }

  /** The client's roles by area. */
  get roleGroups(): RoleGroup[] {
    return groupRoles(this.client?.roles ?? []);
  }

  /** How many different roles the client has. */
  get roleCount(): number {
    return uniqueRoles(this.client?.roles).length;
  }

  /** The configurations the client may use; an empty list allows all of them. */
  get restrictions(): { title: string; ids: string[] }[] {
    return [
      {
        title: 'Verification configs',
        ids: this.client?.allowedPresentationConfigs ?? [],
      },
      { title: 'Credential configs', ids: this.client?.allowedIssuanceConfigs ?? [] },
    ];
  }

  async copyId(): Promise<void> {
    if (!this.client) return;
    await copyToClipboard(
      this.snackBar,
      this.client.clientId,
      'Client ID copied to clipboard',
      'Could not copy the client ID'
    );
  }

  /** Whether the signed-in caller may edit or delete the client. */
  get canManage(): boolean {
    return this.unmanageableRoles.length === 0;
  }

  ngOnInit() {
    const clientId = this.route.snapshot.paramMap.get('id')!;
    this.clientService.getById(clientId).then(
      (client) => (this.client = client),
      (err) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(err, 'Failed to load client'));
        this.router.navigate(['..'], { relativeTo: this.route });
      }
    );
  }

  async deleteClient(): Promise<void> {
    if (
      !this.client?.clientId ||
      this.deleting ||
      !confirm(clientDeleteConfirmation(this.client.clientId, this.apiService.getClientId()))
    ) {
      return;
    }
    const clientId = this.client.clientId;

    this.deleting = true;
    try {
      await this.clientService.delete(clientId);
    } catch (error) {
      this.deleting = false;
      console.error('Error deleting client:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete client'));
      return;
    }

    if (clientId === this.apiService.getClientId()) {
      // The deleted client can no longer renew this session.
      this.apiService.logout();
      this.snackBar.open('Client deleted. You have been signed out.', 'Close', { duration: 5000 });
      await this.router.navigate(['/login']);
      return;
    }
    this.snackBar.open('Client deleted successfully', 'Close', { duration: 3000 });
    // The user may have left the page while the request was running.
    if (!this.destroyRef.destroyed) {
      await this.router.navigate(['../'], { relativeTo: this.route });
    }
  }
}
