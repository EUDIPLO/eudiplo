import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface CancelSessionDialogData {
  /** Number of issuance offers that will be cancelled. */
  offers: number;
  /** Number of verification requests that will be cancelled. */
  requests: number;
}

/** The reason entered by the user, or `undefined` when the dialog was dismissed. */
export interface CancelSessionDialogResult {
  reason?: string;
}

/** "offer", "2 offers", "2 offers and 1 request"…: what is cancelled, in the dialog's words. */
function cancelledItems({ offers, requests }: CancelSessionDialogData): string {
  const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (offers && requests) {
    return `${counted(offers, 'offer')} and ${counted(requests, 'request')}`;
  }
  const count = offers || requests;
  const noun = offers ? 'offer' : 'request';
  return count === 1 ? noun : counted(count, noun);
}

/**
 * Confirms cancelling pending issuance offers or verification requests and asks for an
 * optional reason.
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

  /** For example "Cancel offer?" or "Cancel 2 offers and 1 request?". */
  readonly title = `Cancel ${cancelledItems(this.data)}?`;

  /** The confirm button, without numbers: "Cancel offer", "Cancel requests"… */
  readonly confirmLabel = (() => {
    const { offers, requests } = this.data;
    if (offers && requests) return 'Cancel offers and requests';
    const count = offers || requests;
    return `Cancel ${offers ? 'offer' : 'request'}${count === 1 ? '' : 's'}`;
  })();

  /** What a wallet can no longer do, and what is not undone, for the cancelled types. */
  readonly explanation = (() => {
    const { offers, requests } = this.data;
    const total = offers + requests;
    const these =
      offers && requests
        ? 'these offers and requests'
        : `${total === 1 ? 'this' : 'these'} ${offers ? 'offer' : 'request'}${total === 1 ? '' : 's'}`;
    const notes = [
      ...(offers
        ? [
            'Offers a wallet already redeemed can no longer be cancelled, and credentials that were already issued stay valid.',
          ]
        : []),
      ...(requests ? ['Requests a wallet already answered can no longer be cancelled.'] : []),
    ];
    return `A wallet can no longer use ${these} to start a flow. ${notes.join(' ')}`;
  })();
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
