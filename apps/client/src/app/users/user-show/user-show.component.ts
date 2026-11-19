import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ManagedUserDto, userControllerDeleteUser, userControllerGetUser } from '@eudiplo/sdk-core';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { JwtService } from '../../services/jwt.service';
import { roleChoices } from '../../services/role-grants';
import { groupRoles, type RoleGroup, uniqueRoles } from '../../services/role-groups';
import { RoleLockNoticeComponent } from '../../common/role-lock-notice.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';

@Component({
  selector: 'app-user-show',
  imports: [
    MatSnackBarModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    RouterModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    RoleLockNoticeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './user-show.component.html',
  styleUrl: './user-show.component.scss',
})
export class UserShowComponent implements OnInit {
  user?: ManagedUserDto;
  /** While the delete runs; Edit and Delete wait for it. */
  deleting = false;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly jwtService: JwtService
  ) {}

  /** Roles of the user that keep the signed-in caller from editing or deleting it */
  get unmanageableRoles(): string[] {
    return roleChoices(this.jwtService.getRoles(), this.user?.roles ?? []).unmanageable;
  }

  /** The user's roles by area. */
  get roleGroups(): RoleGroup[] {
    return groupRoles(this.user?.roles ?? []);
  }

  /** How many different roles the user has. */
  get roleCount(): number {
    return uniqueRoles(this.user?.roles).length;
  }

  /** Whether the signed-in caller may edit or delete the user. */
  get canManage(): boolean {
    return this.unmanageableRoles.length === 0;
  }

  ngOnInit(): void {
    const userId = this.route.snapshot.paramMap.get('id')!;
    userControllerGetUser({ path: { id: userId } }).then(
      (user) => (this.user = user.data),
      (err) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(err, 'Failed to load user'));
        this.router.navigate(['..'], { relativeTo: this.route });
      }
    );
  }

  async deleteUser(): Promise<void> {
    if (
      !this.user?.id ||
      !this.canManage ||
      this.deleting ||
      !confirm(`Delete user "${this.user.username}"? This cannot be undone.`)
    ) {
      return;
    }

    this.deleting = true;
    try {
      await userControllerDeleteUser({ path: { id: this.user.id } });
      this.snackBar.open('User deleted successfully', 'Close', { duration: 3000 });
      await this.router.navigate(['../'], { relativeTo: this.route });
    } catch (error) {
      this.deleting = false;
      console.error('Error deleting user:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete user'));
    }
  }
}
