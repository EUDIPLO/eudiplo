import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { filter, map } from 'rxjs';
import { urlPath } from './url-path.util';

/**
 * Shown for an address that no route matches, for example a mistyped one or a
 * bookmark of a page a newer version removed, so the content area is not
 * left empty.
 */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, RouterModule],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Page not found</h1>
          <p>The Web Client has no page with this address.</p>
        </div>
      </header>
      <div class="empty-state">
        <span class="empty-icon"><mat-icon>link_off</mat-icon></span>
        <strong class="address">{{ path() }}</strong>
        <p>
          Check the address. A bookmark or link may also point to a page that this version of
          EUDIPLO no longer has.
        </p>
        <a matButton="filled" routerLink="/dashboard">Go to the dashboard</a>
      </div>
    </div>
  `,
  styleUrl: './not-found.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundComponent {
  private readonly router = inject(Router);

  /**
   * The address as typed, without query and fragment, which may carry more than a path.
   * The router keeps this page for the next unknown address, so it follows the navigation.
   */
  readonly path = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => urlPath(this.router.url))
    ),
    { initialValue: urlPath(this.router.url) }
  );
}
