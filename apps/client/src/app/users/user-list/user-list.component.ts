import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
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
import { apiErrorDetail, getApiErrorMessage, hasHttpStatus } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { searchAndSort } from '../../utils/search-list';
import { uniqueRoles } from '../../services/role-groups';
import { UnavailableCardComponent } from '../../common/unavailable-card.component';
import { LoadErrorComponent } from '../../common/load-error.component';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';

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
export class UserListComponent implements OnInit {
  users: ManagedUserDto[] = [];
  loading = false;
  /** Set when the list could not be loaded, so it is not shown as empty. */
  loadError = '';
  isUnavailable = false;
  unavailableMessage = '';
  /** The user column also shows the e-mail address. */
  displayedColumns: (keyof ManagedUserDto | 'actions')[] = [
    'username',
    'enabled',
    'roles',
    'actions',
  ];

  /** Roles a row shows before "+N more". */
  readonly visibleRoleCount = 4;
  /** Text to find in a user's username, e-mail address or roles. */
  search = '';
  /** The last search result, kept until the users or the search change. */
  private shown?: { users: ManagedUserDto[]; search: string; result: ManagedUserDto[] };

  /** The users that match the search, sorted by username. */
  get shownUsers(): ManagedUserDto[] {
    if (this.shown?.users !== this.users || this.shown.search !== this.search) {
      const result = searchAndSort(
        this.users,
        this.search,
        (user) => [user.username, user.email ?? '', ...(user.roles ?? [])],
        (user) => user.username
      );
      this.shown = { users: this.users, search: this.search, result };
    }
    return this.shown.result;
  }

  clearSearch(): void {
    this.search = '';
  }

  /** A user's roles without repeats. */
  uniqueRoles(user: ManagedUserDto): string[] {
    return uniqueRoles(user.roles);
  }

  /** Where focus goes after a successful Retry removed the error card with its Retry button. */
  @ViewChild('listHeading') private readonly listHeading?: ElementRef<HTMLElement>;

  /** The user whose delete runs; its Delete waits for it. */
  deletingId?: string;

  readonly manageDeniedHint = 'This user has roles you neither hold nor may grant';
  /** Roles of the signed-in caller, read once instead of per row */
  private readonly callerRoles: string[];

  constructor(
    private readonly snackBar: MatSnackBar,
    jwtService: JwtService,
    private readonly injector: Injector
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
    const retrying = this.loadError !== '';
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
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.listHeading?.nativeElement);
    }
  }

  async deleteUser(user: ManagedUserDto): Promise<void> {
    if (
      !user.id ||
      !this.canManage(user) ||
      this.deletingId === user.id ||
      !confirm(`Delete user "${user.username}"? This cannot be undone.`)
    ) {
      return;
    }

    this.deletingId = user.id;
    try {
      await userControllerDeleteUser({ path: { id: user.id } });
      await this.loadUsers();
      this.snackBar.open('User deleted successfully', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error deleting user:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete user'));
    } finally {
      this.deletingId = undefined;
    }
  }
}
