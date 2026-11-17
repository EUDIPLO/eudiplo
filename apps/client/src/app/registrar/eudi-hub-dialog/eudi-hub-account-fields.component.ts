import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  effect,
  inject,
  input,
} from '@angular/core';
import { merge } from 'rxjs';
import { ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import type { EudiHubTokenDialog } from './eudi-hub-token-dialog';

let nextId = 0;

/**
 * The fields every EUDI Hub dialog starts with: how to copy the portal
 * token, the token, the organization with its loader, and the environment.
 * The controls and state belong to the dialog.
 */
@Component({
  selector: 'app-eudi-hub-account-fields',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatRadioModule,
    MatSelectModule,
  ],
  templateUrl: './eudi-hub-account-fields.component.html',
  styleUrl: './eudi-hub-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The fields take part in the dialog's column layout.
  host: { style: 'display: contents' },
})
export class EudiHubAccountFieldsComponent {
  readonly dialog = input.required<EudiHubTokenDialog<unknown>>();
  /** What the live environment issues, said when it is selected. */
  readonly liveHint = input.required<string>();

  readonly environmentLabelId = `eudi-hub-environment-label-${nextId++}`;

  constructor() {
    // The dialog changes these controls too, for example marking them
    // touched on Submit; refresh their errors then.
    const changeDetector = inject(ChangeDetectorRef);
    effect((onCleanup) => {
      const { token, organizationId, environment } = this.dialog();
      const subscription = merge(token.events, organizationId.events, environment.events).subscribe(
        () => changeDetector.markForCheck()
      );
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
