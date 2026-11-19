import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  ManagedUserDto,
  userControllerDeleteUser,
  userControllerGetUsers,
} from '@eudiplo/sdk-core';
import { JwtService } from '../../services/jwt.service';
import { canManageRoles } from '../../services/role-grants';
import { apiErrorDetail, hasHttpStatus } from '../../utils/error-message';
import { uniqueRoles } from '../../services/role-groups';
import { BaseAsyncListComponent } from '../../common/base-async-list.component';
import { UnavailableCardComponent } from '../../common/unavailable-card.component';
import { LoadErrorComponent } from '../../common/load-error.component';

@Component({
  selector: 'app-user-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    RouterModule,
    FormsModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    LoadErrorComponent,
    UnavailableCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './user-list.component.html',
  styleUrl: './user-list.component.scss',
})
export class UserListComponent extends BaseAsyncListComponent<ManagedUserDto> {
  protected readonly loadFailedMessage = 'Failed to load users';

  /** The user column also shows the e-mail address. */
  displayedColumns: (keyof ManagedUserDto | 'actions')[] = [
    'username',
    'enabled',
    'roles',
    'actions',
  ];

  /** Roles a row shows before "+N more". */
  readonly visibleRoleCount = 4;

  readonly manageDeniedHint = 'This user has roles you neither hold nor may grant';
  /** Roles of the signed-in caller, read once instead of per row */
  private readonly callerRoles: string[];

  constructor(jwtService: JwtService) {
    super();
    this.callerRoles = jwtService.getRoles();
  }

  get users(): ManagedUserDto[] {
    return this.items;
  }

  protected fetchItems(): Promise<ManagedUserDto[]> {
    return userControllerGetUsers<true>().then((res) => res.data);
  }

  protected override unavailableReason(error: unknown): string | undefined {
    if (!hasHttpStatus(error, 501)) return undefined;
    return apiErrorDetail(error) ?? 'This instance does not manage people.';
  }

  /** Text to find in a user's username, e-mail address or roles. */
  protected override searchTexts(user: ManagedUserDto): string[] {
    return [user.username, user.email ?? '', ...(user.roles ?? [])];
  }

  protected override sortName(user: ManagedUserDto): string {
    return user.username;
  }

  /** A user's roles without repeats. */
  uniqueRoles(user: ManagedUserDto): string[] {
    return uniqueRoles(user.roles);
  }

  /** Whether the signed-in caller may edit or delete the user. */
  canManage(user: ManagedUserDto): boolean {
    return canManageRoles(this.callerRoles, user.roles ?? []);
  }

  async deleteUser(user: ManagedUserDto): Promise<void> {
    if (!user.id || !this.canManage(user)) {
      return;
    }
    const id = user.id;
    await this.deleteItem({
      item: user,
      id,
      question: `Delete user "${user.username}"? This cannot be undone.`,
      request: () => userControllerDeleteUser({ path: { id } }),
      deleted: 'User deleted successfully',
      failed: 'Failed to delete user',
    });
  }
}
