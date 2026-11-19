import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BaseAsyncListComponent } from './base-async-list.component';

class TestList extends BaseAsyncListComponent<string> {
  protected readonly loadFailedMessage = 'Failed to load things';
  readonly fetch = vi.fn<() => Promise<string[]>>();

  get loaded(): string[] {
    return this.items;
  }

  protected fetchItems(): Promise<string[]> {
    return this.fetch();
  }
}

describe('BaseAsyncListComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps a failed load apart from an empty list and loads again on retry', async () => {
    // The base class injects, as Angular does when it creates a list component.
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(document.createElement('div')) }],
    });
    const list = TestBed.runInInjectionContext(() => new TestList());
    list.fetch
      .mockRejectedValueOnce({ statusCode: 403, message: 'Forbidden resource' })
      .mockResolvedValueOnce(['a']);

    await list.loadItems();

    expect(list.loadError).toBe('Failed to load things: Forbidden resource');
    expect(list.loading).toBe(false);

    await list.loadItems();

    expect(list.loadError).toBe('');
    expect(list.loaded).toEqual(['a']);
  });

  it('shows the reason instead of an error when the instance offers no such items', async () => {
    class UnavailableList extends TestList {
      protected override unavailableReason(error: unknown): string | undefined {
        return (error as { statusCode?: number }).statusCode === 501
          ? 'Managed elsewhere'
          : undefined;
      }
    }
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(document.createElement('div')) }],
    });
    const list = TestBed.runInInjectionContext(() => new UnavailableList());
    list.fetch.mockRejectedValueOnce({ statusCode: 501 }).mockResolvedValueOnce(['a']);

    await list.loadItems();

    expect(list.unavailableMessage).toBe('Managed elsewhere');
    expect(list.loadError).toBe('');
    expect(list.loaded).toEqual([]);

    await list.loadItems();

    expect(list.unavailableMessage).toBe('');
    expect(list.loaded).toEqual(['a']);
  });
});

describe('BaseAsyncListComponent delete', () => {
  class DeletingList extends TestList {
    remove(request: () => Promise<unknown>): Promise<boolean> {
      return this.deleteItem({
        item: 'a',
        id: 'a',
        question: 'Delete "a"?',
        request,
        deleted: 'Thing deleted',
        failed: 'Failed to delete thing',
      });
    }
  }

  function render() {
    const snackBar = { open: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: MatSnackBar, useValue: snackBar },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
      ],
    });
    const list = TestBed.runInInjectionContext(() => new DeletingList());
    list.fetch.mockResolvedValue(['a', 'b']);
    return { list, snackBar };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('deletes once after confirming, says so and takes the row out of the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { list, snackBar } = render();
    await list.loadItems();
    let finish: () => void = () => undefined;
    const request = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

    const first = list.remove(request);
    expect(list.deletingId).toBe('a');
    // A second click while the first delete runs sends nothing.
    expect(await list.remove(request)).toBe(false);
    finish();
    expect(await first).toBe(true);

    expect(request).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(snackBar.open).toHaveBeenCalledWith('Thing deleted', 'Close', { duration: 3000 });
    // The row goes without loading the list again.
    expect(list.fetch).toHaveBeenCalledOnce();
    expect(list.loaded).toEqual(['b']);
    expect(list.deletingId).toBeUndefined();
  });

  it('sends nothing when the question is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { list } = render();
    const request = vi.fn();

    expect(await list.remove(request)).toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(list.deletingId).toBeUndefined();
  });

  it('says on the other rows that their Delete waits for the running one', () => {
    const { list } = render();
    expect(list.deleteTooltip('b', 'Delete thing', 'Deleting the thing…')).toBe('Delete thing');

    list.deletingId = 'a';

    expect(list.deleteTooltip('a', 'Delete thing', 'Deleting the thing…')).toBe(
      'Deleting the thing…'
    );
    expect(list.deleteTooltip('b', 'Delete thing', 'Deleting the thing…')).toBe(
      'Wait until the other delete has finished'
    );
  });

  it('reports a failed delete with the reason and keeps the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { list, snackBar } = render();

    await list.remove(() => Promise.reject({ statusCode: 409, message: 'In use' }));

    expect(snackBar.open.mock.lastCall?.[0]).toBe('Failed to delete thing: In use');
    expect(consoleError).toHaveBeenCalledWith('Failed to delete thing:', expect.anything());
    expect(list.loaded).toEqual([]);
    expect(list.deletingId).toBeUndefined();
  });
});
