import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { KeyChainService } from '../key-chain.service';
import { KeyChainResponseDto, KeyChainUpdateDto, RotationPolicyUpdateDto } from '@eudiplo/sdk-core';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { keyUsages, type KeyUsageType } from '../key-usage';
import type { PageWithUnsavedChanges } from '../../services/unsaved-changes.service';
import { LoadErrorComponent } from '../../common/load-error.component';
import { showFieldsToFix } from '../../common/field-to-fix.util';
import { ROTATION_DAYS_ERROR, rotationDaysValidators } from '../rotation-days';

@Component({
  selector: 'app-key-management-create',
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatSnackBarModule,
    MatTooltipModule,
    ReactiveFormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './key-management-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './key-management-create.component.scss',
})
export class KeyManagementCreateComponent implements OnInit, PageWithUnsavedChanges {
  public form: FormGroup;
  public keyChainId?: string;
  public keyChain?: KeyChainResponseDto;
  public isLoading = false;
  /** Set when the key chain could not be loaded; the page then offers Retry instead of a form. */
  public loadError = '';
  /** While a save runs, so a second click does not send it again. */
  public saving = false;
  readonly rotationDaysError = ROTATION_DAYS_ERROR;

  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  private readonly injector = inject(Injector);

  constructor(
    private readonly keyChainService: KeyChainService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly fb: FormBuilder
  ) {
    this.keyChainId = this.route.snapshot.params['id'];
    this.form = this.fb.group({
      description: [''],
      // Rotation policy fields, shown for key chains that can rotate (see showsRotation)
      rotationEnabled: [false],
      rotationIntervalDays: [30, rotationDaysValidators],
      certValidityDays: [365, rotationDaysValidators],
    });
    // Hidden fields must not block the form.
    this.form.get('rotationEnabled')!.valueChanges.subscribe(() => this.syncRotationControls());
  }

  ngOnInit(): void {
    if (this.keyChainId) {
      void this.load();
    } else {
      // This component is now only for editing, redirect to wizard for create
      this.router.navigate(['/keys/create']);
    }
  }

  /** Loads the key chain into the form; on failure the page shows why, with Retry. */
  async load(): Promise<void> {
    this.isLoading = true;
    this.loadError = '';
    try {
      this.keyChain = await this.keyChainService.getById(this.keyChainId!);

      this.form.patchValue({
        description: this.keyChain.description || '',
        rotationEnabled: this.keyChain.rotationPolicy?.enabled || false,
        rotationIntervalDays: this.keyChain.rotationPolicy?.intervalDays || 30,
        certValidityDays: this.keyChain.rotationPolicy?.certValidityDays || 365,
      });
      this.syncRotationControls();
    } catch (error) {
      console.error('Error loading key chain:', error);
      this.loadError = getApiErrorMessage(error, 'Failed to load key chain');
    } finally {
      this.isLoading = false;
    }
  }

  /** The usage as the key pages name it, such as "Status List". */
  get usageLabel(): string {
    const usage = this.keyChain?.usageType as KeyUsageType | undefined;
    return (usage && keyUsages[usage]?.short) ?? this.keyChain?.usageType ?? '';
  }

  get usageIcon(): string {
    const usage = this.keyChain?.usageType as KeyUsageType | undefined;
    return (usage && keyUsages[usage]?.icon) ?? 'key';
  }

  get isInternalChain(): boolean {
    return this.keyChain?.type === 'internalChain';
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty;
  }

  /**
   * Whether the page offers the rotation policy: for a key chain with its own root CA, and for
   * any other key chain whose rotation is on (set through the API, the CLI or an import), so
   * that it can be turned off before a rotation replaces its certificate with a self-signed one.
   */
  get showsRotation(): boolean {
    return this.isInternalChain || !!this.keyChain?.rotationPolicy?.enabled;
  }

  /** The tooltip of Save while it waits. */
  get saveTooltip(): string {
    return this.saving ? 'Saving the key chain…' : '';
  }

  /** Enables the interval and validity fields only while the Rotation Policy section shows them. */
  private syncRotationControls(): void {
    const enabled = this.showsRotation && !!this.form.get('rotationEnabled')!.value;
    for (const name of ['rotationIntervalDays', 'certValidityDays']) {
      const control = this.form.get(name)!;
      if (enabled) control.enable({ emitEvent: false });
      else control.disable({ emitEvent: false });
    }
  }

  async onSubmit(): Promise<void> {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
    if (this.saving) return;
    if (this.form.invalid) {
      showFieldsToFix(this.form, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
        sections: [
          {
            name: 'Rotation Policy',
            controls: [this.form.get('rotationIntervalDays')!, this.form.get('certValidityDays')!],
          },
        ],
      });
      return;
    }

    // An empty description is sent as such, so clearing it clears the stored one.
    const updateDto: KeyChainUpdateDto = {
      description: ((this.form.get('description')?.value as string | null) ?? '').trim(),
    };
    if (this.showsRotation) {
      updateDto.rotationPolicy = this.buildRotationPolicy();
    }

    this.saving = true;
    try {
      await this.keyChainService.update(this.keyChainId!, updateDto);
      this.form.markAsPristine();
      this.snackBar.open('Key chain updated successfully', 'Close', {
        duration: 3000,
      });

      this.router.navigate(['../'], { relativeTo: this.route });
    } catch (error) {
      console.error('Error updating key chain:', error);
      openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to update key chain'));
    } finally {
      this.saving = false;
    }
  }

  /** The rotation policy of the form; the validators have checked both numbers. */
  private buildRotationPolicy(): RotationPolicyUpdateDto {
    if (!this.form.value.rotationEnabled) return { enabled: false };
    return {
      enabled: true,
      intervalDays: Number(this.form.value.rotationIntervalDays),
      certValidityDays: Number(this.form.value.certValidityDays),
    };
  }
}
