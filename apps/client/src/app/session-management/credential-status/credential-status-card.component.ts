import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  type OnChanges,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SessionManagementService } from '../session-management.service';
import {
  groupCredentialStatus,
  statusLabel,
  STATUS_REVOKED,
  STATUS_SUSPENDED,
  STATUS_VALID,
  type CredentialStatusGroup,
  type CredentialStatusValue,
} from './credential-status';
import {
  CredentialStatusDialogComponent,
  type CredentialStatusDialogData,
} from './credential-status-dialog.component';

/**
 * Shows the status of the credentials issued in a session and lets the user
 * revoke, suspend or reinstate them per credential configuration. Renders
 * nothing while the session holds no credential with a status.
 */
@Component({
  selector: 'app-credential-status-card',
  standalone: true,
  imports: [MatCardModule, MatButtonModule, MatChipsModule, MatIconModule, MatTooltipModule],
  templateUrl: './credential-status-card.component.html',
  styleUrl: './credential-status-card.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class CredentialStatusCardComponent implements OnChanges {
  @Input({ required: true }) sessionId!: string;
  /** The session's status; the credential status is read again when it changes. */
  @Input() sessionStatus?: string;

  private readonly sessions = inject(SessionManagementService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly changeDetector = inject(ChangeDetectorRef);

  groups: CredentialStatusGroup[] = [];
  updating = false;

  readonly statusLabel = statusLabel;
  readonly valid = STATUS_VALID;
  readonly revoked = STATUS_REVOKED;
  readonly suspended = STATUS_SUSPENDED;

  ngOnChanges(): void {
    this.load();
  }

  async load(): Promise<void> {
    try {
      this.groups = groupCredentialStatus(await this.sessions.getCredentialStatus(this.sessionId));
    } catch (error) {
      console.error('Error loading credential status:', error);
      this.groups = [];
    }
    this.changeDetector.markForCheck();
  }

  entryTooltip(group: CredentialStatusGroup): string {
    return group.entries
      .map((entry) => `${entry.statusListId} #${entry.index}: ${statusLabel(entry.status)}`)
      .join('\n');
  }

  change(group: CredentialStatusGroup, status: CredentialStatusValue): void {
    const count = group.entries.filter((entry) => entry.status !== status).length;
    this.dialog
      .open<CredentialStatusDialogComponent, CredentialStatusDialogData, boolean>(
        CredentialStatusDialogComponent,
        {
          data: { status, credentialConfigurationId: group.credentialConfigurationId, count },
          width: '480px',
        }
      )
      .afterClosed()
      .subscribe(async (confirmed) => {
        if (!confirmed) return;
        this.updating = true;
        try {
          await this.sessions.updateCredentialStatus(
            this.sessionId,
            status,
            group.credentialConfigurationId
          );
          this.snackBar.open(`Credentials ${statusLabel(status)}`, 'Close', { duration: 3000 });
        } catch (error) {
          console.error('Error changing credential status:', error);
          this.snackBar.open(`The status could not be changed: ${errorMessage(error)}`, 'Close', {
            duration: 5000,
            panelClass: ['error-snackbar'],
          });
        } finally {
          this.updating = false;
          await this.load();
        }
      });
  }
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'please try again';
}
