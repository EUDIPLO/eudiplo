import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { FlexLayoutModule } from 'ngx-flexible-layout';

/**
 * Takes the place of a list this instance does not serve (the backend answers
 * `501`), for example API clients or people managed by another identity
 * provider, with the backend's reason.
 */
@Component({
  selector: 'app-unavailable-card',
  standalone: true,
  imports: [FlexLayoutModule, MatCardModule, MatIconModule],
  template: `
    <mat-card class="mat-elevation-z2">
      <mat-card-content>
        <div fxLayout="column" fxLayoutGap="8px">
          <div fxLayout="row" fxLayoutAlign="start center" fxLayoutGap="8px">
            <mat-icon color="warn">info</mat-icon>
            <strong>{{ heading }}</strong>
          </div>
          <p>{{ message }}</p>
        </div>
      </mat-card-content>
    </mat-card>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnavailableCardComponent {
  @Input({ required: true }) heading = '';
  @Input({ required: true }) message = '';
}
