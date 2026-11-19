import { Directive, ElementRef, inject, Injector, OnInit, ViewChild } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { getApiErrorMessage } from '../utils/error-message';
import { SearchCache } from '../utils/search-list';
import { confirmAndDelete, type DeleteAction } from './confirm-delete';
import { focusAfterRenderIfLost, focusRowAfterRemoval } from './focus-if-lost.util';

/**
 * What a row's Delete asks, sends and reports: `item` is the row's item, `id` what `deletingId`
 * holds while the delete runs.
 */
export type ListItemDelete<T> = Omit<DeleteAction, 'busy'> & { item: T; id: string };

/**
 * Base of a list screen that loads its items on init and again on Retry.
 * The page heading carries `#listHeading` and `tabindex="-1"`: a retry
 * removes the error card with its focused Retry button, so after a
 * successful retry focus continues from the heading, unless the user has
 * moved it elsewhere meanwhile.
 */
@Directive()
export abstract class BaseAsyncListComponent<T> implements OnInit {
  protected items: T[] = [];
  loading = true;
  /** Set when the items could not be loaded, so the page does not show an empty list. */
  loadError = '';
  /**
   * Why this instance offers no such items, such as when another identity provider manages
   * them; set from `unavailableReason`, and the page shows it instead of the list.
   */
  unavailableMessage = '';

  /** Message when loading fails, such as "Failed to load webhook endpoints". */
  protected abstract readonly loadFailedMessage: string;

  /** The item whose delete runs; its Delete waits for it. */
  deletingId?: string;

  @ViewChild('listHeading') private readonly listHeading?: ElementRef<HTMLElement>;
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly snackBar = inject(MatSnackBar);

  /** Text to find in the items of a list with a search bar. */
  search = '';
  /** The last search result, kept until the items or the search change. */
  private readonly searchCache = new SearchCache<T>(
    (item) => this.searchTexts?.(item) ?? [],
    (item) => this.sortName?.(item) ?? ''
  );
  /** The link in each row that the focus moves to after a delete removed the row before it. */
  protected readonly rowLinkSelector: string = 'a.item-link';

  ngOnInit(): void {
    void this.loadItems();
  }

  protected abstract fetchItems(): Promise<T[]>;

  /**
   * The reason to show when the load failed because the instance offers no such items, such as
   * for a 501, or undefined for an error that a Retry may fix.
   */
  protected unavailableReason?(error: unknown): string | undefined;

  async loadItems(): Promise<void> {
    const retrying = this.loadError !== '';
    this.loading = true;
    this.loadError = '';
    this.unavailableMessage = '';
    try {
      this.items = await this.fetchItems();
    } catch (error) {
      const unavailable = this.unavailableReason?.(error);
      if (unavailable === undefined) {
        console.error(`${this.loadFailedMessage}:`, error);
        this.loadError = getApiErrorMessage(error, this.loadFailedMessage);
      } else {
        this.unavailableMessage = unavailable;
        this.items = [];
      }
    } finally {
      this.loading = false;
    }
    if (retrying && !this.loadError) {
      focusAfterRenderIfLost(this.injector, () => this.listHeading?.nativeElement);
    }
  }

  /** The texts of an item that the search looks in; a list with a search bar names them. */
  protected searchTexts?(item: T): readonly string[];

  /** The name the shown items are sorted by; without one they keep their order. */
  protected sortName?(item: T): string;

  /** The items that match the search, sorted by `sortName`. */
  get shownItems(): T[] {
    return this.searchCache.result(this.items, this.search);
  }

  clearSearch(): void {
    this.search = '';
  }

  /** Tooltip of a row's Delete: busy on the row being deleted, waiting on the others. */
  deleteTooltip(id: string, action: string, busy: string): string {
    if (this.deletingId === id) return busy;
    if (this.deletingId !== undefined) return 'Wait until the other delete has finished';
    return action;
  }

  /**
   * Deletes one item after the caller confirmed it and takes its row out of the list. The
   * focused Delete left with the row, so focus moves to the row now in its place (its
   * `rowLinkSelector`), or to the page heading when no row is left. A second click while a
   * delete runs does nothing. Returns whether the item was deleted.
   */
  protected async deleteItem({ item, id, ...action }: ListItemDelete<T>): Promise<boolean> {
    if (this.deletingId !== undefined) {
      return false;
    }
    const deleted = await confirmAndDelete(this.snackBar, {
      ...action,
      busy: (busy) => (this.deletingId = busy ? id : undefined),
    });
    if (deleted) {
      const index = this.shownItems.indexOf(item);
      this.items = this.items.filter((other) => other !== item);
      focusRowAfterRemoval(
        this.injector,
        () => [...this.host.nativeElement.querySelectorAll<HTMLElement>(this.rowLinkSelector)],
        index,
        () => this.listHeading?.nativeElement
      );
    }
    return deleted;
  }
}
