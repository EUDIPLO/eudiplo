import { Component, OnInit, ChangeDetectionStrategy, DestroyRef } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  clientControllerDeleteClient,
  clientControllerGetClient,
  ClientEntity,
} from '@eudiplo/sdk-core';
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

/** Roles of one area, as the client page groups them. */
interface RoleGroup {
  title: string;
  icon: string;
  roles: string[];
}

/** The areas the client page groups roles into; a role in none of them falls under "Other". */
const roleAreas: { title: string; icon: string; roles: string[] }[] = [
  {
    title: 'Issuance',
    icon: 'card_giftcard',
    roles: ['issuance:manage', 'issuance:offer', 'credentials:status'],
  },
  {
    title: 'Presentation',
    icon: 'verified_user',
    roles: ['presentation:manage', 'presentation:request'],
  },
  { title: 'Sessions and audit', icon: 'history', roles: ['sessions:read', 'audit:read'] },
  { title: 'Keys and certificates', icon: 'key', roles: ['keys:manage', 'registrar:manage'] },
  {
    title: 'Administration',
    icon: 'admin_panel_settings',
    roles: ['clients:manage', 'users:manage', 'tenant:admin', 'tenants:manage'],
  },
];

/** The client's roles by area, each role once, in the order of the areas. */
export function groupRoles(roles: string[]): RoleGroup[] {
  const own = new Set(roles);
  const groups: RoleGroup[] = roleAreas
    .map((area) => ({ ...area, roles: area.roles.filter((role) => own.has(role)) }))
    .filter((group) => group.roles.length > 0);
  const known = new Set(roleAreas.flatMap((area) => area.roles));
  const other = [...own].filter((role) => !known.has(role));
  if (other.length) groups.push({ title: 'Other', icon: 'more_horiz', roles: other });
  return groups;
}

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
    private readonly destroyRef: DestroyRef
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
    return new Set(this.client?.roles ?? []).size;
  }

  /** The configurations the client may use; an empty list allows all of them. */
  get restrictions(): { title: string; ids: string[] }[] {
    return [
      {
        title: 'Presentation configurations',
        ids: this.client?.allowedPresentationConfigs ?? [],
      },
      { title: 'Credential configurations', ids: this.client?.allowedIssuanceConfigs ?? [] },
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
    clientControllerGetClient({ path: { id: clientId } }).then(
      (client) => (this.client = client.data),
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
      await clientControllerDeleteClient({ path: { id: clientId } });
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
