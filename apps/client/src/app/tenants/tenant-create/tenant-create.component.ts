import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  tenantControllerGetTenant,
  tenantControllerInitTenant,
  tenantControllerUpdateTenant,
} from '@eudiplo/sdk-core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Role, roles } from '../../services/jwt.service';
import { SecretDialogComponent } from '../client/secret-dialog/secret-dialog.component';
import { ApiService } from '../../core';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { showFieldsToFix } from '../../common/field-to-fix.util';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';

@Component({
  selector: 'app-tenant-create',
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    FlexLayoutModule,
    MatSelectModule,
    MatSlideToggleModule,
    RouterModule,
    MatIconModule,
    MatTooltipModule,
    MatDialogModule,
    LoadErrorComponent,
  ],
  templateUrl: './tenant-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './tenant-create.component.scss',
})
export class TenantCreateComponent implements OnInit {
  tenantForm: FormGroup;
  isSubmitting = false;
  isEditMode = false;
  /** While the tenant to edit loads; the form waits for it. */
  loading = false;
  /** Set when the tenant to edit could not be loaded; the form stays hidden. */
  loadError = '';

  roles = roles;

  /** Where focus goes after a successful retry removed the error card with its Retry button. */
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;
  /** Holds the fields; Save focuses the first invalid one. */
  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  private readonly injector = inject(Injector);

  constructor(
    private readonly fb: FormBuilder,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly dialog: MatDialog,
    private readonly apiService: ApiService
  ) {
    this.tenantForm = this.fb.group({
      // TENANT_ID_PATTERN of the backend, which trims the ID: it is also a folder name.
      id: ['', [Validators.required, Validators.pattern(/^\s*[a-z0-9][a-z0-9_-]{0,62}\s*$/)]],
      name: ['', [Validators.required]],
      description: [''],
      // Off when the identity provider manages the clients (OIDC_PROVIDER=generic).
      createAdminClient: [true],
      roles: new FormControl<Role[]>(['clients:manage'], [Validators.required]),
    });
    // A disabled control is not validated, so no roles are needed without the client.
    this.tenantForm.get('createAdminClient')!.valueChanges.subscribe((create: boolean) => {
      const roles = this.tenantForm.get('roles')!;
      if (create) {
        roles.enable();
      } else {
        roles.disable();
      }
    });
  }

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.isEditMode = true;
      this.loadTenant(id);
    }
  }

  /** Loads the tenant again after a failed load. */
  retryLoad(): void {
    void this.loadTenant(this.route.snapshot.paramMap.get('id')!);
  }

  private async loadTenant(id: string): Promise<void> {
    const retrying = this.loadError !== '';
    this.loading = true;
    this.loadError = '';
    try {
      const tenant = await tenantControllerGetTenant<true>({ path: { id } });
      this.tenantForm.patchValue({
        id: tenant.data.id,
        name: tenant.data.name,
        description: tenant.data.description ?? '',
      });
      // Disable ID field in edit mode
      this.tenantForm.get('id')?.disable();
      this.tenantForm.markAsPristine();
    } catch (error) {
      this.loadError = getApiErrorMessage(error, 'Failed to load tenant');
    } finally {
      this.loading = false;
    }
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
    }
  }

  /** Save stays focusable while a save runs, so its tooltip says why it waits. */
  get saveTooltip(): string {
    return this.isSubmitting ? 'Saving the tenant…' : '';
  }

  async onSubmit(): Promise<void> {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
    if (this.isSubmitting) return;
    if (this.tenantForm.invalid) {
      showFieldsToFix(this.tenantForm, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
      });
      return;
    }

    this.isSubmitting = true;

    try {
      if (this.isEditMode) {
        const id = this.route.snapshot.paramMap.get('id')!;
        const descriptionControl = this.tenantForm.get('description')!;
        const description = descriptionControl.value.trim();
        const body = {
          name: this.tenantForm.get('name')!.value.trim(),
          ...(descriptionControl.dirty
            ? { description: description === '' ? null : description }
            : {}),
        };

        await tenantControllerUpdateTenant<true>({
          path: { id },
          body,
        });
        this.snackBar.open('Tenant updated successfully', 'Close', { duration: 3000 });
        await this.router.navigate(['../'], { relativeTo: this.route });
      } else {
        const value = this.tenantForm.getRawValue();
        const description = value.description.trim();
        const body = {
          id: value.id.trim(),
          name: value.name.trim(),
          ...(value.createAdminClient ? { roles: value.roles } : {}),
          ...(description ? { description } : {}),
        };
        const result = await tenantControllerInitTenant<true>({ body });

        // Cast to expected type since SDK returns generic response
        // The backend returns { ...tenant, client: { clientId, clientSecret } } on creation
        const tenantData = result.data as typeof result.data & {
          client?: { clientId: string; clientSecret: string };
        };

        // Show secret dialog if client credentials were created
        if (tenantData?.client?.clientId && tenantData?.client?.clientSecret) {
          const dialogRef = this.dialog.open(SecretDialogComponent, {
            data: {
              clientId: tenantData.client.clientId,
              secret: tenantData.client.clientSecret,
              apiUrl: this.apiService.getBaseUrl(),
            },
            width: '500px',
            disableClose: true,
          });

          // Wait for dialog to close before navigating
          dialogRef.afterClosed().subscribe(() => {
            this.router.navigate(['../', body.id], { relativeTo: this.route });
          });
        } else {
          this.snackBar.open('Tenant created successfully', 'Close', { duration: 3000 });
          await this.router.navigate(['../', body.id], { relativeTo: this.route });
        }
      }
    } catch (error) {
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, `Failed to ${this.isEditMode ? 'update' : 'create'} tenant`)
      );
    } finally {
      this.isSubmitting = false;
    }
  }

  onCancel(): void {
    this.router.navigate(['../'], { relativeTo: this.route });
  }
}
