import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, type FormGroup } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  userControllerCreateUser,
  userControllerGetUser,
  userControllerUpdateUser,
} from '@eudiplo/sdk-core';
import { JwtService } from '../../services/jwt.service';
import { type RoleOption, roleChoices } from '../../services/role-grants';
import { getApiErrorMessage } from '../../utils/error-message';
import { RoleLockNoticeComponent } from '../../common/role-lock-notice.component';
import { UserTemporaryPasswordDialogComponent } from '../user-temporary-password-dialog/user-temporary-password-dialog.component';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { showFieldsToFix } from '../../common/field-to-fix.util';

@Component({
  selector: 'app-user-create',
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    FlexLayoutModule,
    MatSelectModule,
    RouterModule,
    MatTooltipModule,
    MatCheckboxModule,
    RoleLockNoticeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './user-create.component.html',
})
export class UserCreateComponent implements OnInit {
  private readonly jwtService = inject(JwtService);

  userForm: FormGroup;
  isSubmitting = false;
  /**
   * Roles available for selection: the roles the signed-in caller may grant,
   * plus the other roles of the edited user, which stay selected and cannot
   * be changed.
   */
  roleOptions: RoleOption[] = [];
  /** Explains which roles the caller can grant */
  grantHint = '';
  /** Roles of the edited user that the caller neither holds nor may grant */
  unmanageableRoles: string[] = [];
  loaded = false;
  id?: string | null;

  /** Holds the fields; Save focuses the first invalid one. */
  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  private readonly injector = inject(Injector);

  constructor(
    private readonly fb: FormBuilder,
    private readonly dialog: MatDialog,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly route: ActivatedRoute
  ) {
    this.userForm = this.fb.group({
      username: ['', [Validators.required, Validators.minLength(1)]],
      enabled: [true],
      roles: [[], [Validators.required]],
    });

    this.roleOptions = roleChoices(this.jwtService.getRoles()).options;
    this.grantHint = this.jwtService.grantHint();
  }

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id');
    if (this.id) {
      this.loaded = true;
      userControllerGetUser({ path: { id: this.id } }).then((res) => {
        if (!res.data) {
          this.snackBar.open('User not found', 'Close', { duration: 3000 });
          this.router.navigate(['../..'], { relativeTo: this.route });
          return;
        }

        this.userForm.patchValue(res.data);
        this.userForm.get('username')?.disable();
        const choices = roleChoices(this.jwtService.getRoles(), res.data.roles ?? []);
        this.roleOptions = choices.options;
        this.unmanageableRoles = choices.unmanageable;
        if (this.unmanageableRoles.length > 0) {
          this.userForm.disable();
        }
      });
    }
  }

  /** Save stays focusable while it cannot be used, so its tooltip says why. */
  get saveTooltip(): string {
    if (this.isSubmitting) return 'Saving the user…';
    if (this.unmanageableRoles.length > 0) {
      return 'You cannot change this user: it has roles you neither hold nor may grant';
    }
    return '';
  }

  async onSubmit(): Promise<void> {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
    if (this.isSubmitting || this.unmanageableRoles.length > 0) return;
    if (this.userForm.invalid) {
      showFieldsToFix(this.userForm, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
      });
      return;
    }
    this.isSubmitting = true;

    try {
      const payload = this.userForm.getRawValue();

      if (this.loaded) {
        await userControllerUpdateUser({
          path: { id: this.id! },
          body: payload,
        });
        this.snackBar.open('User updated successfully', 'Close', { duration: 3000 });
        await this.router.navigate(['..'], { relativeTo: this.route });
      } else {
        const response = await userControllerCreateUser({ body: payload });
        const temporaryPassword = response.data?.temporaryPassword;
        if (temporaryPassword) {
          const dialogRef = this.dialog.open(UserTemporaryPasswordDialogComponent, {
            data: {
              username: response.data?.username || payload.username,
              temporaryPassword,
            },
            width: '500px',
            disableClose: true,
          });

          dialogRef.afterClosed().subscribe(() => {
            this.router.navigate(['..'], { relativeTo: this.route });
          });
        } else {
          this.snackBar.open('User created successfully', 'Close', { duration: 3000 });
          await this.router.navigate(['..'], { relativeTo: this.route });
        }
      }
    } catch (error) {
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, `Failed to ${this.loaded ? 'update' : 'create'} user`)
      );
    } finally {
      this.isSubmitting = false;
    }
  }

  onCancel(): void {
    this.router.navigate(['../'], { relativeTo: this.route });
  }
}
