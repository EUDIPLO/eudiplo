import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  ManagedUserDto,
  userControllerDeleteUser,
  userControllerGetUsers,
} from '@eudiplo/sdk-core';
import { JwtService } from '../../services/jwt.service';
import { canManageRoles } from '../../services/role-grants';
import { apiErrorDetail, getApiErrorMessage, hasHttpStatus } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { UnavailableCardComponent } from '../../common/unavailable-card.component';
import { LoadErrorComponent } from '../../common/load-error.component';

@Component({
  selector: 'app-user-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    RouterModule,
    FlexLayoutModule,
    MatChipsModule,
    MatTooltipModule,
    LoadErrorComponent,
    UnavailableCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './user-list.component.html',
})
export class UserListComponent implements OnInit {
  users: ManagedUserDto[] = [];
  loading = false;
  /** Set when the list could not be loaded, so it is not shown as empty. */
  loadError = '';
  isUnavailable = false;
  unavailableMessage = '';
  displayedColumns: (keyof ManagedUserDto | 'actions')[] = [
    'username',
    'roles',
    'enabled',
    'actions',
  ];

  readonly manageDeniedHint = 'This user has roles you neither hold nor may grant';
  /** Roles of the signed-in caller, read once instead of per row */
  private readonly callerRoles: string[];

  constructor(
    private readonly snackBar: MatSnackBar,
    jwtService: JwtService
  ) {
    this.callerRoles = jwtService.getRoles();
  }

  /** Whether the signed-in caller may edit or delete the user. */
  canManage(user: ManagedUserDto): boolean {
    return canManageRoles(this.callerRoles, user.roles ?? []);
  }

  ngOnInit(): void {
    void this.loadUsers();
  }

  async loadUsers(): Promise<void> {
    this.loading = true;
    this.loadError = '';
    this.isUnavailable = false;
    this.unavailableMessage = '';

    try {
      this.users = await userControllerGetUsers<true>().then((res) => res.data);
    } catch (error) {
      if (hasHttpStatus(error, 501)) {
        this.isUnavailable = true;
        this.unavailableMessage = apiErrorDetail(error) ?? 'This instance does not manage people.';
        this.users = [];
      } else {
        console.error('Error loading users:', error);
        this.loadError = getApiErrorMessage(error, 'Failed to load users');
      }
    } finally {
      this.loading = false;
    }
  }

  async deleteUser(user: ManagedUserDto): Promise<void> {
    if (!user.id || !confirm(`Delete user "${user.username}"? This cannot be undone.`)) {
      return;
    }

    try {
      await userControllerDeleteUser({ path: { id: user.id } });
      await this.loadUsers();
      this.snackBar.open('User deleted successfully', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error deleting user:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete user'));
    }
  }
}
