import { ElementRef, Injector, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type AbstractControl, FormControl, Validators } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstFieldWithError, showFieldsToFix } from '../../common/field-to-fix.util';
import {
  apiErrorDetail,
  asSentence,
  getApiErrorMessage,
  hasHttpStatus,
} from '../../utils/error-message';
import { EUDI_HUB_PORTAL_URL, EudiHubOrganization, EudiHubService } from '../eudi-hub.service';

/** What the backend accepts: an RFC 6750 bearer token, with or without `Bearer `. */
const TOKEN = /^\s*([Bb][Ee][Aa][Rr][Ee][Rr]\s+)?[\w.~+/-]+=*\s*$/;

const UUID = /^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;

/** An http(s) URL of at most 2048 characters, as the backend accepts it. */
export function httpUrlControl(required = true): FormControl<string> {
  return new FormControl('', {
    nonNullable: true,
    validators: [
      ...(required ? [Validators.required] : []),
      Validators.maxLength(2048),
      Validators.pattern(/^\s*https?:\/\/\S+\s*$/),
    ],
  });
}

/**
 * What every EUDI Hub dialog shares: the pasted portal token, which lives in
 * the dialog's form only, the organization it acts for, the environment, and
 * running one request that closes the dialog with its result. The dialog
 * cannot be cancelled while the request runs. `EudiHubAccountFieldsComponent`
 * renders these controls and signals, so they are its template contract.
 */
export abstract class EudiHubTokenDialog<R> {
  protected readonly eudiHub = inject(EudiHubService);
  private readonly dialogRef = inject(MatDialogRef<unknown, R | undefined>);
  private readonly snackBar = inject(MatSnackBar);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly portalUrl = EUDI_HUB_PORTAL_URL;

  readonly token = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(16_384), Validators.pattern(TOKEN)],
  });
  readonly organizationId = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.pattern(UUID)],
  });
  readonly environment = new FormControl<'sandbox' | 'live'>('sandbox', { nonNullable: true });

  /** Organizations of the token's user; undefined until they were loaded. */
  readonly organizations = signal<EudiHubOrganization[] | undefined>(undefined);
  readonly loadingOrganizations = signal(false);
  /** Why the organizations could not be loaded, shown next to the organization field. */
  readonly organizationsError = signal<string | undefined>(undefined);
  readonly requesting = signal(false);
  /** Why the last request failed, shown above the actions. */
  readonly error = signal<string | undefined>(undefined);

  constructor() {
    // A list loaded with another token may name other organizations; the
    // chosen ID stays, in the field to enter it by hand.
    this.token.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.organizations.set(undefined);
    });
  }

  async loadOrganizations(): Promise<void> {
    if (this.loadingOrganizations()) return;
    if (this.token.invalid) {
      this.token.markAsTouched();
      return;
    }
    this.loadingOrganizations.set(true);
    this.organizationsError.set(undefined);
    try {
      const organizations = await this.eudiHub.listOrganizations(this.token.value);
      this.organizations.set(organizations);
      if (organizations.length === 1) {
        this.organizationId.setValue(organizations[0].id);
      } else if (!organizations.some(({ id }) => id === this.organizationId.value.trim())) {
        // The select cannot show an ID typed by hand that is not in the list.
        this.organizationId.setValue('');
      }
    } catch (error) {
      this.organizations.set(undefined);
      this.organizationsError.set(
        `${asSentence(this.errorMessage(error, 'Could not load the organizations'))} You can still enter the organization ID by hand.`
      );
    } finally {
      this.loadingOrganizations.set(false);
    }
  }

  /**
   * Runs `request` once and closes the dialog with its result. EUDIPLO
   * refuses before it calls the EUDI Hub or after the EUDI Hub refused;
   * after any other failure the result may have been stored, which the
   * message then says with `mayHaveStored`.
   */
  protected async run(
    request: () => Promise<R>,
    fallback: string,
    mayHaveStored: string
  ): Promise<void> {
    if (this.requesting()) return;
    this.requesting.set(true);
    this.error.set(undefined);
    try {
      this.dialogRef.close(await request());
    } catch (error) {
      const message = this.errorMessage(error, fallback);
      const refused = [400, 403, 404, 409].some((status) => hasHttpStatus(error, status));
      this.error.set(refused ? message : `${asSentence(message)} ${mayHaveStored}`);
    } finally {
      this.requesting.set(false);
    }
  }

  /**
   * The backend's message as it is, since it already says what failed;
   * `fallback` only leads a message without one, a validation refusal or a
   * failed connection.
   */
  protected errorMessage(error: unknown, fallback: string): string {
    const answered = typeof (error as { statusCode?: unknown } | null)?.statusCode === 'number';
    const listsIssues = Array.isArray((error as { errors?: unknown } | null)?.errors);
    const detail = answered && !listsIssues ? apiErrorDetail(error) : undefined;
    return detail ?? getApiErrorMessage(error, fallback);
  }

  /** Marks the fields, says in a snackbar what to fix and focuses the first one. */
  protected showFieldsToFix(form: AbstractControl): void {
    showFieldsToFix(form, {
      snackBar: this.snackBar,
      injector: this.injector,
      container: () => this.host.nativeElement,
      // The shared account fields bind [formControl], not formControlName.
      field: () => firstFieldWithError(this.host.nativeElement),
    });
  }

  cancel(): void {
    // A running request may still store its result; the page reloads either way.
    if (this.requesting()) return;
    this.dialogRef.close();
  }
}
