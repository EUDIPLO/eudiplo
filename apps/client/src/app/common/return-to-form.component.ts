import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Input,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

import { focusIfFocusWasLost } from './focus-if-lost.util';

/**
 * Takes the place of a create page once the item exists, when a form in
 * another tab opened the page (see `fromFormQueryParams`). It says to return
 * to that tab, where the form waits with what was entered, and offers the new
 * item for whoever wants to look at it here.
 */
@Component({
  selector: 'app-return-to-form',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatIconModule, RouterLink],
  template: `
    <mat-card appearance="outlined" class="return-to-form">
      <mat-card-content>
        <mat-icon aria-hidden="true">check_circle</mat-icon>
        <div class="text">
          <h3 #headingElement tabindex="-1">{{ heading }}</h3>
          <p>{{ hint }}</p>
        </div>
        <a mat-stroked-button [routerLink]="link">{{ linkLabel }}</a>
      </mat-card-content>
    </mat-card>
  `,
  styleUrl: './return-to-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReturnToFormComponent implements AfterViewInit {
  /** What was created, for example `Key chain "Tokens" created`. */
  @Input({ required: true }) heading = '';
  /** Router link of the new item. */
  @Input({ required: true }) link: readonly unknown[] = [];
  @Input({ required: true }) linkLabel = '';

  readonly hint =
    'Your form is still open in the tab you came from. Continue there; you can close this tab.';

  private readonly liveAnnouncer = inject(LiveAnnouncer);

  @ViewChild('headingElement')
  private readonly headingElement?: ElementRef<HTMLHeadingElement>;

  /**
   * The card replaces the page's form, and with it the focused submit button,
   * so the heading takes the focus. Focus the user has moved elsewhere stays
   * there, and the card is announced instead.
   */
  ngAfterViewInit(): void {
    const heading = this.headingElement?.nativeElement;
    focusIfFocusWasLost(heading);
    if (heading && document.activeElement !== heading) {
      void this.liveAnnouncer.announce(`${this.heading}. ${this.hint}`);
    }
  }
}
