import { Directive, ElementRef, inject, Injector, OnInit, ViewChild } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { getApiErrorMessage } from '../utils/error-message';
import { searchAndSort } from '../utils/search-list';
import { confirmAndDelete, type DeleteAction } from './confirm-delete';
import { focusAfterRenderIfLost } from './focus-if-lost.util';

/** What a row's Delete asks, sends and reports; `id` is what `deletingId` holds meanwhile. */
export type ListItemDelete = Omit<DeleteAction, 'busy'> & { id: string };

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

  /** Message when loading fails, such as "Failed to load webhook endpoints". */
  protected abstract readonly loadFailedMessage: string;

  /** The item whose delete runs; its Delete waits for it. */
  deletingId?: string;

  @ViewChild('listHeading') private readonly listHeading?: ElementRef<HTMLElement>;
  private readonly injector = inject(Injector);
  protected readonly snackBar = inject(MatSnackBar);

  /** Text to find in the items of a list with a search bar. */
  search = '';
  /** The last search result, kept until the items or the search change. */
  private searchResult?: { items: T[]; search: string; result: T[] };

  ngOnInit(): void {
    void this.loadItems();
  }

  protected abstract fetchItems(): Promise<T[]>;

  async loadItems(): Promise<void> {
    const retrying = this.loadError !== '';
    this.loading = true;
    this.loadError = '';
    try {
      this.items = await this.fetchItems();
    } catch (error) {
      console.error(`${this.loadFailedMessage}:`, error);
      this.loadError = getApiErrorMessage(error, this.loadFailedMessage);
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
    if (this.searchResult?.items !== this.items || this.searchResult.search !== this.search) {
      const result = searchAndSort(
        this.items,
        this.search,
        (item) => this.searchTexts?.(item) ?? [],
        (item) => this.sortName?.(item) ?? ''
      );
      this.searchResult = { items: this.items, search: this.search, result };
    }
    return this.searchResult.result;
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
   * Deletes one item after the caller confirmed it, then loads the list again and, as the
   * focused Delete left with its row, continues focus from the page heading. A second click
   * while a delete runs does nothing.
   */
  protected async deleteItem({ id, ...action }: ListItemDelete): Promise<void> {
    if (this.deletingId !== undefined) {
      return;
    }
    const deleted = await confirmAndDelete(this.snackBar, {
      ...action,
      busy: (busy) => (this.deletingId = busy ? id : undefined),
    });
    if (deleted) {
      await this.loadItems();
      focusAfterRenderIfLost(this.injector, () => this.listHeading?.nativeElement);
    }
  }
}
