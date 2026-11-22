import { Injectable, type OnDestroy } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { filter, type Subscription } from 'rxjs';

/** A page that loses what the user entered when it is left. */
export interface PageWithUnsavedChanges {
  /** True while leaving the page would lose what the user entered. */
  hasUnsavedChanges(): boolean;
  /** The question to confirm before leaving; without it, a question about unsaved changes. */
  leaveQuestion?(): string;
}

export const UNSAVED_CHANGES_QUESTION = 'Leave this page? Your unsaved changes will be lost.';

function isPageWithUnsavedChanges(page: unknown): page is PageWithUnsavedChanges {
  return (
    typeof page === 'object' &&
    page !== null &&
    typeof (page as Partial<PageWithUnsavedChanges>).hasUnsavedChanges === 'function'
  );
}

/**
 * Asks before the user leaves a page with unsaved changes: within the client through
 * `unsavedChangesGuard`, before a logout, and before a reload, closing the tab or leaving
 * for another site through the browser's own question.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedChangesService implements OnDestroy {
  /** The page the router shows. */
  private page?: PageWithUnsavedChanges;
  /** The user agreed to leave the page; the navigation away does not ask again. */
  private confirmed = false;
  private readonly navigations: Subscription;
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.confirmed || !this.page?.hasUnsavedChanges()) return;
    event.preventDefault();
    // Older browsers show their question only when `returnValue` is set.
    event.returnValue = '';
  };

  constructor(router: Router) {
    // A navigation that ends, or one that another guard stopped, asks again next time.
    this.navigations = router.events
      .pipe(
        filter(
          (event) =>
            event instanceof NavigationEnd ||
            event instanceof NavigationCancel ||
            event instanceof NavigationError
        )
      )
      .subscribe(() => (this.confirmed = false));
    globalThis.addEventListener('beforeunload', this.beforeUnload);
  }

  ngOnDestroy(): void {
    this.navigations.unsubscribe();
    globalThis.removeEventListener('beforeunload', this.beforeUnload);
  }

  /** The router outlet shows `page`. */
  shown(page: unknown): void {
    this.page = isPageWithUnsavedChanges(page) ? page : undefined;
    this.confirmed = false;
  }

  /** The router outlet no longer shows `page`. */
  hidden(page: unknown): void {
    if (this.page === page) this.page = undefined;
  }

  /**
   * True when `page` (by default the page the router shows) has no unsaved
   * changes or the user agrees to leave it. After an agreement, the navigation
   * away and a reload do not ask again.
   */
  confirmLeave(page: unknown = this.page): boolean {
    if (this.confirmed || !isPageWithUnsavedChanges(page) || !page.hasUnsavedChanges()) {
      return true;
    }
    this.confirmed = globalThis.confirm(page.leaveQuestion?.() ?? UNSAVED_CHANGES_QUESTION);
    return this.confirmed;
  }
}
