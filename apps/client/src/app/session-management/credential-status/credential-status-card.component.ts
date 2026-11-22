import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Injector,
  Input,
  type OnChanges,
  type SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
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
 * Shows the status of the credentials issued in a session and, with
 * `canChange`, lets the user revoke, suspend or reinstate them per credential
 * configuration. Renders nothing while the session holds no credential with a
 * status. A status that could not be read is shown as such with a retry, so the
 * session does not look like one without revocable credentials.
 */
@Component({
  selector: 'app-credential-status-card',
  standalone: true,
  imports: [
    MatCardModule,
    MatButtonModule,
    MatChipsModule,
    MatIconModule,
    MatTooltipModule,
    LoadErrorComponent,
  ],
  templateUrl: './credential-status-card.component.html',
  styleUrl: './credential-status-card.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class CredentialStatusCardComponent implements OnChanges {
  @Input({ required: true }) sessionId!: string;
  /** The session's status; the credential status is read again when it changes. */
  @Input() sessionStatus?: string;
  /** Whether the caller may change the status (credentials:status or issuance:manage). */
  @Input() canChange = false;

  private readonly sessions = inject(SessionManagementService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly injector = inject(Injector);
  /** Takes the focus when the focused action goes away with the status it changed. */
  @ViewChild('cardTitle', { read: ElementRef })
  private readonly cardTitle?: ElementRef<HTMLElement>;

  groups: CredentialStatusGroup[] = [];
  /** Why the status could not be read; the card then shows this instead of the status. */
  loadError = '';
  /**
   * Set when a Retry found no credentials with a status: the card then says so instead of
   * vanishing with the focused Retry, so its title can take the focus.
   */
  emptyAfterRetry = false;
  updating = false;

  readonly statusLabel = statusLabel;
  readonly valid = STATUS_VALID;
  readonly revoked = STATUS_REVOKED;
  readonly suspended = STATUS_SUSPENDED;

  ngOnChanges(changes: SimpleChanges): void {
    // Another session: its card is hidden while it has no status entries, as on a first load.
    if (changes['sessionId']) this.emptyAfterRetry = false;
    void this.load();
  }

  async load(): Promise<void> {
    try {
      this.groups = groupCredentialStatus(await this.sessions.getCredentialStatus(this.sessionId));
      this.loadError = '';
    } catch (error) {
      console.error('Error loading credential status:', error);
      this.groups = [];
      this.loadError = getApiErrorMessage(error, 'Failed to load the credential status');
    }
    this.changeDetector.markForCheck();
  }

  /** Reads the status again after a failure, then continues from the card title. */
  async retryLoad(): Promise<void> {
    await this.load();
    if (!this.loadError) {
      this.emptyAfterRetry = this.groups.length === 0;
      this.changeDetector.markForCheck();
      focusAfterRenderIfLost(this.injector, () => this.cardTitle?.nativeElement);
    }
  }

  /** What the failed read keeps the caller from, for a caller who could change the status. */
  get loadErrorHint(): string {
    return this.canChange
      ? 'Until it is loaded, the credentials of this session cannot be revoked, suspended or reinstated here.'
      : '';
  }

  /** A change the lists allow, which the caller's roles do not. */
  get changeNeedsRole(): boolean {
    return (
      !this.canChange &&
      this.groups.some((group) => group.canRevoke || group.canSuspend || group.canReinstate)
    );
  }

  /** Formatted like the other dates on the session page. */
  formatDate(value: string): string {
    return this.sessions.formatDate(value);
  }

  entryTooltip(group: CredentialStatusGroup): string {
    return group.entries
      .map((entry) => {
        const line = `${entry.statusListId} #${entry.index}: ${statusLabel(entry.status)}`;
        return entry.statusUpdatedAt
          ? `${line} (changed ${this.formatDate(entry.statusUpdatedAt)})`
          : line;
      })
      .join('\n');
  }

  /** The actions stay focusable while a change runs, so their tooltip says why they wait. */
  get updatingTooltip(): string {
    return this.updating ? 'Changing the credential status…' : '';
  }

  change(group: CredentialStatusGroup, status: CredentialStatusValue): void {
    // `disabledInteractive` keeps the actions clickable while they look disabled.
    if (this.updating) return;
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
          openErrorSnackBar(
            this.snackBar,
            getApiErrorMessage(error, 'The status could not be changed'),
            'Close',
            { panelClass: ['error-snackbar'] }
          );
        } finally {
          // The actions wait until the new status is shown, so none acts on the old one.
          await this.load();
          this.updating = false;
          // The new status may no longer offer the action that was used.
          focusAfterRenderIfLost(this.injector, () => this.cardTitle?.nativeElement);
        }
      });
  }
}
