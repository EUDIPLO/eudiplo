import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { EudiHubAccessCertificate } from '../eudi-hub.service';
import { EudiHubTokenDialog, httpUrlControl } from './eudi-hub-token-dialog';

/** The key chain a certificate is requested for. */
export interface EudiHubDialogData {
  keyId: string;
  description?: string;
}

/**
 * Requests an access certificate for a standalone access key chain from the
 * German EUDI Hub. The user pastes the access token of the portal; it lives
 * in this dialog's form only and is sent with the two requests. Closes with
 * the stored certificate, or with nothing when cancelled.
 */
@Component({
  selector: 'app-eudi-hub-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatRadioModule,
    MatSelectModule,
  ],
  templateUrl: './eudi-hub-dialog.component.html',
  styleUrl: './eudi-hub-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EudiHubDialogComponent extends EudiHubTokenDialog<EudiHubAccessCertificate> {
  readonly data = inject<EudiHubDialogData>(MAT_DIALOG_DATA);

  readonly form = new FormGroup({
    token: this.token,
    organizationId: this.organizationId,
    environment: this.environment,
    supportUri: httpUrlControl(),
    name: new FormControl('', { nonNullable: true }),
  });

  /** Name the EUDI Hub shows when the user enters none. */
  get defaultName(): string {
    return this.data.description?.trim() || this.data.keyId;
  }

  async submit(): Promise<void> {
    if (this.requesting()) return;
    if (this.form.invalid) {
      this.showFieldsToFix(this.form);
      return;
    }
    const { token, organizationId, environment, supportUri, name } = this.form.getRawValue();
    await this.run(
      () =>
        this.eudiHub.requestAccessCertificate({
          token,
          organizationId: organizationId.trim(),
          keyId: this.data.keyId,
          environment,
          supportUri: supportUri.trim(),
          name: name.trim() || undefined,
        }),
      'The EUDI Hub did not issue a certificate',
      'A certificate may have been stored anyway: close this dialog to see what the key holds before you request again.'
    );
  }
}
