import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';

/**
 * Takes the place of a list this instance does not serve (the backend answers
 * `501`), for example API clients or people managed by another identity
 * provider, with the backend's reason.
 */
@Component({
  selector: 'app-unavailable-card',
  standalone: true,
  imports: [MatCardModule, MatIconModule],
  template: `
    <mat-card class="mat-elevation-z2">
      <mat-card-content>
        <div class="unavailable-copy">
          <div class="unavailable-heading">
            <mat-icon color="warn">info</mat-icon>
            <strong>{{ heading }}</strong>
          </div>
          <p>{{ message }}</p>
        </div>
      </mat-card-content>
    </mat-card>
  `,
  styleUrl: './unavailable-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnavailableCardComponent {
  @Input({ required: true }) heading = '';
  @Input({ required: true }) message = '';
}
