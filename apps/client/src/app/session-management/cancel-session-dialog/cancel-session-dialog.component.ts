import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface CancelSessionDialogData {
  /** Number of sessions that will be cancelled. */
  count: number;
}

/** The reason entered by the user, or `undefined` when the dialog was dismissed. */
export interface CancelSessionDialogResult {
  reason?: string;
}

/**
 * Confirms cancelling pending offers and asks for an optional reason.
 */
@Component({
  selector: 'app-cancel-session-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule,
  ],
  templateUrl: './cancel-session-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class CancelSessionDialogComponent {
  readonly data = inject<CancelSessionDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef =
    inject<MatDialogRef<CancelSessionDialogComponent, CancelSessionDialogResult>>(MatDialogRef);

  readonly reason = new FormControl('', {
    nonNullable: true,
    validators: [Validators.maxLength(500)],
  });

  confirm(): void {
    if (this.reason.invalid) return;
    const reason = this.reason.value.trim();
    this.dialogRef.close(reason ? { reason } : {});
  }
}
