import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { copyToClipboard } from '../../utils/copy-to-clipboard';

export interface OidcClientSecretDialogData {
  clientId: string;
  clientSecret: string;
  issuer: string;
}

/** Shows a new client secret once; EUDIPLO keeps only its hash. */
@Component({
  selector: 'app-oidc-client-secret-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './oidc-client-secret-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './oidc-client-secret-dialog.component.scss',
})
export class OidcClientSecretDialogComponent {
  readonly data = inject<OidcClientSecretDialogData>(MAT_DIALOG_DATA);
  private readonly snackBar = inject(MatSnackBar);

  copy(text: string, what: string): Promise<void> {
    return copyToClipboard(
      this.snackBar,
      text,
      `${what} copied to clipboard`,
      `Could not copy the ${what.toLowerCase()}. Select it and copy it by hand.`
    );
  }
}
