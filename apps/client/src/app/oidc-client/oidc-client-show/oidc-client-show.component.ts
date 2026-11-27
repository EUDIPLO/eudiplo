import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  type OnInit,
  ViewChild,
  ViewChildren,
  type QueryList,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import type { OidcClientResponseDto, OidcClientSecretDto } from '@eudiplo/sdk-core';
import { focusAfterRenderIfLost, focusRowAfterRemoval } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { JwtService } from '../../services/jwt.service';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import {
  OidcClientSecretDialogComponent,
  type OidcClientSecretDialogData,
} from '../oidc-client-secret-dialog/oidc-client-secret-dialog.component';
import { MAX_SECRETS, PROFILE_LABELS } from '../oidc-client-create/oidc-client-form';
import { OidcClientService } from '../oidc-client.service';
import { oidcClientDeleteConfirmation } from '../oidc-client-delete-confirmation';
import { ReadOnlyNoticeComponent } from '../../common/read-only-notice.component';
import { RoleLockDirective } from '../../common/role-lock.directive';
import { PRESENTATION_WRITE_ROLES } from '../../services/resource-roles';

/** The value of a `datetime-local` input for an ISO timestamp, in local time. */
export function toLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

@Component({
  selector: 'app-oidc-client-show',
  imports: [
    RoleLockDirective,
    ReadOnlyNoticeComponent,
    DatePipe,
    ReactiveFormsModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    RouterModule,
    LoadErrorComponent,
  ],
  templateUrl: './oidc-client-show.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './oidc-client-show.component.scss',
})
export class OidcClientShowComponent implements OnInit {
  /** Creating, changing and deleting it needs presentation:manage; reading needs less. */
  readonly writeRoles = PRESENTATION_WRITE_ROLES;

  readonly profileLabels = PROFILE_LABELS;
  client: OidcClientResponseDto | undefined;
  /** Set when the client could not be loaded, so the page is not left blank. */
  loadError = '';
  /** While the client is deleted, so a second click does not delete it again. */
  deleting = false;
  /** While a secret is added, so a second click does not add another. */
  addingSecret = false;
  /** IDs of the secrets with a request in flight. */
  readonly busySecrets = new Set<string>();
  /** The expiry field of each secret, by secret ID. */
  readonly expiry = new Map<string, FormControl<string>>();

  @ViewChildren('secretHeading') private readonly secretHeadings?: QueryList<
    ElementRef<HTMLElement>
  >;
  @ViewChild('pageHeading', { read: ElementRef })
  private readonly pageHeading?: ElementRef<HTMLElement>;
  @ViewChild('addSecretButton', { read: ElementRef })
  private readonly addSecretButton?: ElementRef<HTMLElement>;

  private readonly service = inject(OidcClientService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);
  private readonly jwtService = inject(JwtService);

  /** A caller without presentation:manage reads the secrets with their expiry fields disabled. */
  get readOnly(): boolean {
    return !this.jwtService.hasRole(this.writeRoles);
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    // After a failed load, the Retry button that has the focus goes with the error card.
    const retry = !!this.loadError;
    this.loadError = '';
    this.service.getById(id).then(
      (client) => {
        this.show(client);
        if (retry) focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
      },
      (error) => {
        console.error('Load error:', error);
        this.loadError = getApiErrorMessage(error, 'Failed to load OIDC client');
      }
    );
  }

  get discoveryUrl(): string {
    return this.client ? `${this.client.issuer}/.well-known/openid-configuration` : '';
  }

  get canAddSecret(): boolean {
    return (this.client?.secrets.length ?? 0) < MAX_SECRETS;
  }

  /** Tooltip of Add secret: why it cannot be used, or what it does. */
  get addSecretTooltip(): string {
    if (this.addingSecret) return 'Adding a secret…';
    return this.canAddSecret
      ? 'Add a second secret to rotate without downtime'
      : `A client holds at most ${MAX_SECRETS} secrets. Delete the one you no longer use first.`;
  }

  /** Tooltip of a secret's Delete: why the last secret cannot be deleted. */
  deleteSecretTooltip(): string {
    return this.client && this.client.secrets.length > 1
      ? 'Delete secret'
      : 'The last secret cannot be deleted. Add a new one first.';
  }

  isExpired(secret: OidcClientSecretDto): boolean {
    return !!secret.expiresAt && new Date(secret.expiresAt).getTime() <= Date.now();
  }

  copy(text: string, what: string): Promise<void> {
    return copyToClipboard(
      this.snackBar,
      text,
      `${what} copied to clipboard`,
      `Could not copy the ${what.toLowerCase()}. Select it and copy it by hand.`
    );
  }

  deleteClient(): void {
    const client = this.client;
    if (
      !client ||
      this.deleting ||
      !this.jwtService.hasRole('presentation:manage') ||
      !confirm(oidcClientDeleteConfirmation(client.name))
    ) {
      return;
    }
    this.deleting = true;
    this.service
      .delete(client.id)
      .then(() => {
        this.snackBar.open('OIDC client deleted', 'Close', { duration: 3000 });
        return this.router.navigate(['../'], { relativeTo: this.route });
      })
      .catch((error) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete OIDC client'));
        console.error('Delete error:', error);
      })
      .finally(() => (this.deleting = false));
  }

  addSecret(): void {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    const client = this.client;
    if (!client || this.addingSecret || !this.canAddSecret) return;
    this.addingSecret = true;
    this.service
      .addSecret(client.id)
      .then(({ clientSecret, ...secret }) => {
        client.secrets = [...client.secrets, secret];
        this.expiry.set(secret.id, new FormControl('', { nonNullable: true }));
        const data: OidcClientSecretDialogData = {
          clientId: client.id,
          clientSecret,
          issuer: client.issuer,
        };
        this.dialog.open(OidcClientSecretDialogComponent, { data, disableClose: true });
      })
      .catch((error) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to add a secret'));
        console.error('Add secret error:', error);
      })
      .finally(() => (this.addingSecret = false));
  }

  /** Saves the expiry of a secret from its field; an empty field keeps the secret valid. */
  saveExpiry(secret: OidcClientSecretDto): void {
    const value = this.expiry.get(secret.id)?.value ?? '';
    const date = value ? new Date(value) : null;
    if (date && Number.isNaN(date.getTime())) {
      openErrorSnackBar(this.snackBar, 'Enter a valid date and time.');
      return;
    }
    if (
      date &&
      date.getTime() <= Date.now() &&
      !confirm('This moment has passed: the secret is refused from now on. Continue?')
    ) {
      return;
    }
    this.updateExpiry(secret, date ? date.toISOString() : null);
  }

  clearExpiry(secret: OidcClientSecretDto): void {
    this.updateExpiry(secret, null);
  }

  private updateExpiry(secret: OidcClientSecretDto, expiresAt: string | null): void {
    const client = this.client;
    if (!client || this.busySecrets.has(secret.id)) return;
    this.busySecrets.add(secret.id);
    this.service
      .setSecretExpiry(client.id, secret.id, expiresAt)
      .then((updated) => {
        client.secrets = client.secrets.map((s) => (s.id === updated.id ? updated : s));
        this.expiry.get(secret.id)?.setValue(toLocalDateTime(updated.expiresAt));
        this.snackBar.open(
          updated.expiresAt ? 'Expiry saved' : 'Expiry removed; the secret stays valid',
          'Close',
          { duration: 3000 }
        );
      })
      .catch((error) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to save the expiry'));
        console.error('Update secret error:', error);
      })
      .finally(() => this.busySecrets.delete(secret.id));
  }

  deleteSecret(secret: OidcClientSecretDto, index: number): void {
    const client = this.client;
    if (!client || client.secrets.length <= 1 || this.busySecrets.has(secret.id)) return;
    if (
      !confirm(
        'Delete this secret? Applications that still use it can no longer sign users in. This cannot be undone.'
      )
    ) {
      return;
    }
    this.busySecrets.add(secret.id);
    this.service
      .deleteSecret(client.id, secret.id)
      .then(() => {
        client.secrets = client.secrets.filter((s) => s.id !== secret.id);
        this.expiry.delete(secret.id);
        this.snackBar.open('Secret deleted', 'Close', { duration: 3000 });
        focusRowAfterRemoval(
          this.injector,
          () => this.secretHeadings?.map((heading) => heading.nativeElement),
          index,
          () => this.addSecretButton?.nativeElement
        );
      })
      .catch((error) => {
        openErrorSnackBar(this.snackBar, getApiErrorMessage(error, 'Failed to delete the secret'));
        console.error('Delete secret error:', error);
      })
      .finally(() => this.busySecrets.delete(secret.id));
  }

  private show(client: OidcClientResponseDto): void {
    this.client = client;
    this.expiry.clear();
    for (const secret of client.secrets) {
      this.expiry.set(
        secret.id,
        new FormControl(
          { value: toLocalDateTime(secret.expiresAt), disabled: this.readOnly },
          { nonNullable: true }
        )
      );
    }
  }
}
