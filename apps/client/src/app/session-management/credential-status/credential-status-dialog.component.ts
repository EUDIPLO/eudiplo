import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { STATUS_REVOKED, STATUS_SUSPENDED, type CredentialStatusValue } from './credential-status';

export interface CredentialStatusDialogData {
  status: CredentialStatusValue;
  credentialConfigurationId: string;
  /** Number of credentials whose status changes. */
  count: number;
}

/**
 * Confirms a credential status change. Closes with `true` when confirmed.
 */
@Component({
  selector: 'app-credential-status-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ action }} {{ credentials }}?</h2>
    <mat-dialog-content>
      <p>
        Applies to {{ credentials }} of <strong>{{ data.credentialConfigurationId }}</strong>
        issued in this session. Verifiers see the change once the status list is published again.
      </p>
      @if (data.status === revoked) {
        <p><strong>Revocation is final:</strong> a revoked credential cannot be reinstated.</p>
      } @else if (data.status === suspended) {
        <p>A suspension can be lifted later.</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false">Back</button>
      <button
        mat-raised-button
        [color]="data.status === revoked ? 'warn' : 'primary'"
        type="button"
        [mat-dialog-close]="true"
      >
        {{ action }}
      </button>
    </mat-dialog-actions>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class CredentialStatusDialogComponent {
  readonly data = inject<CredentialStatusDialogData>(MAT_DIALOG_DATA);
  readonly revoked = STATUS_REVOKED;
  readonly suspended = STATUS_SUSPENDED;

  get action(): string {
    switch (this.data.status) {
      case STATUS_REVOKED:
        return 'Revoke';
      case STATUS_SUSPENDED:
        return 'Suspend';
      default:
        return 'Reinstate';
    }
  }

  get credentials(): string {
    return this.data.count === 1 ? '1 credential' : `${this.data.count} credentials`;
  }
}
