import type { Provider, Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A list screen built on `BaseAsyncListComponent` and the texts it shows. */
export interface ListStatesScenario<S> {
  component: Type<unknown>;
  /** The feature service whose `fetchMethod` the screen's `fetchItems()` calls. */
  service: Type<S>;
  fetchMethod: keyof S & string;
  /** An item as the service returns it; `id` is the first column of the table. */
  item: { id: string; [field: string]: unknown };
  /** Accessible name of the loading indicator. */
  loading: string;
  /** Text of the empty state. */
  empty: string;
  /** Text of the empty state's link to the create page. */
  create: string;
  /**
   * Accessible name of the header's Create icon button, which is also its tooltip. Leave it out
   * when the header's Create is a link with visible text, which needs no tooltip.
   */
  createButton?: string;
  /** `loadFailedMessage`, the prefix of the message when loading fails. */
  failure: string;
  /** Further providers the screen needs, such as a JwtService with the roles to create. */
  providers?: Provider[];
  /** The page heading that takes the focus after Retry; `h2` unless given. */
  heading?: string;
  /** Text the item's first table cell contains, such as its name; unless given, the cell is the `id`. */
  firstCell?: string;
}

async function waitUntil(
  fixture: ComponentFixture<unknown>,
  check: (element: HTMLElement) => void
): Promise<HTMLElement> {
  const element = fixture.nativeElement as HTMLElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    check(element);
  });
  return element;
}

/** Lets a render hook that a load may have scheduled run before an assertion. */
async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  fixture.detectChanges();
}

function loadingIndicator(element: HTMLElement, label: string): Element | null {
  return element.querySelector(`[aria-label="${label}"]`);
}

function retryButton(element: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(element.querySelectorAll<HTMLButtonElement>('app-load-error button')).find(
    (button) => button.textContent?.includes('Retry')
  );
}

function expectFailure(element: HTMLElement, failure: string): void {
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    `${failure}: Database unavailable`
  );
}

/**
 * Specs for the states every list screen on `BaseAsyncListComponent` shows:
 * loading, empty with a link to create, and a failed load with Retry, with
 * focus kept on Retry or moved to the page heading afterwards.
 */
export function describeListStates<S>(screen: ListStatesScenario<S>): void {
  const heading = screen.heading ?? 'h2';
  /** Checks that the table shows the item. */
  const expectItemRow = (element: HTMLElement): void => {
    const text = element.querySelector('td.mat-mdc-cell')?.textContent;
    if (screen.firstCell === undefined) expect(text).toBe(screen.item.id);
    else expect(text).toContain(screen.firstCell);
  };
  describe('loading, empty and error states', () => {
    let fetchItems: ReturnType<typeof vi.fn>;

    function render(): ComponentFixture<unknown> {
      TestBed.configureTestingModule({
        imports: [screen.component],
        providers: [
          provideRouter([]),
          { provide: screen.service, useValue: { [screen.fetchMethod]: fetchItems } },
          ...(screen.providers ?? []),
        ],
      });
      const fixture = TestBed.createComponent(screen.component);
      fixture.detectChanges();
      return fixture;
    }

    /** Renders a screen whose first load fails; the failure is logged, not hidden. */
    async function renderFailed(): Promise<{
      fixture: ComponentFixture<unknown>;
      element: HTMLElement;
      retry: HTMLButtonElement;
    }> {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fixture = render();
      const element = await waitUntil(fixture, (el) => expectFailure(el, screen.failure));
      const retry = retryButton(element);
      expect(retry).toBeDefined();
      expect(consoleError).toHaveBeenCalledWith(`${screen.failure}:`, expect.anything());
      return { fixture, element, retry: retry as HTMLButtonElement };
    }

    beforeEach(() => {
      fetchItems = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('shows the loading indicator while the request is pending', () => {
      fetchItems.mockReturnValue(new Promise(() => undefined));

      const element = render().nativeElement as HTMLElement;

      expect(loadingIndicator(element, screen.loading)).not.toBeNull();
      expect(element.textContent).not.toContain(screen.empty);
      expect(element.querySelector('table')).toBeNull();
      expect(element.querySelector('[role="alert"]')).toBeNull();
    });

    it('shows an empty state with a link to create the first item', async () => {
      fetchItems.mockResolvedValue([]);

      const fixture = render();
      const element = await waitUntil(fixture, (el) =>
        expect(el.textContent).toContain(screen.empty)
      );

      const create = Array.from(element.querySelectorAll('a')).find((link) =>
        link.textContent?.includes(screen.create)
      );
      expect(create?.getAttribute('href')).toBe('/create');
      expect(loadingIndicator(element, screen.loading)).toBeNull();
      expect(element.querySelector('table')).toBeNull();
      expect(element.querySelector('[role="alert"]')).toBeNull();
      // Only a retry moves focus; opening the page leaves it alone.
      await settle(fixture);
      expect(document.activeElement).not.toBe(element.querySelector(heading));
    });

    it.skipIf(screen.createButton === undefined)('names the Create button like its tooltip', () => {
      fetchItems.mockResolvedValue([]);
      const fixture = render();

      const button = fixture.debugElement.query(
        By.css(`button[aria-label="${screen.createButton}"]`)
      );
      expect(button.injector.get(MatTooltip).message).toBe(screen.createButton);
    });

    it('reports a failed load instead of an empty list and focuses the heading after Retry', async () => {
      fetchItems
        .mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' })
        .mockResolvedValueOnce([screen.item]);

      const { fixture, element, retry } = await renderFailed();
      expect(element.textContent).not.toContain(screen.empty);
      expect(element.querySelector('table')).toBeNull();

      retry.focus();
      retry.click();

      await waitUntil(fixture, (el) => expectItemRow(el));
      expect(element.querySelector('[role="alert"]')).toBeNull();
      expect(fetchItems).toHaveBeenCalledTimes(2);
      // Retry left with the error card, so focus continues from the page heading.
      await waitUntil(fixture, (el) =>
        expect(document.activeElement).toBe(el.querySelector(heading))
      );
    });

    it('leaves focus alone that the user moved elsewhere during the retry', async () => {
      let succeed: (items: unknown[]) => void = () => undefined;
      fetchItems
        .mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' })
        .mockReturnValueOnce(new Promise((resolve) => (succeed = resolve)));

      const { fixture, retry } = await renderFailed();
      retry.focus();
      retry.click();
      fixture.detectChanges();
      const search = document.body.appendChild(document.createElement('input'));
      search.focus();
      succeed([screen.item]);

      try {
        await waitUntil(fixture, (el) => expectItemRow(el));
        await settle(fixture);
        expect(document.activeElement).toBe(search);
      } finally {
        search.remove();
      }
    });

    it('ignores a retry that finishes after the user left the page', async () => {
      let succeed: (items: unknown[]) => void = () => undefined;
      fetchItems
        .mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' })
        .mockReturnValueOnce(new Promise((resolve) => (succeed = resolve)));

      const { fixture } = await renderFailed();
      const consoleError = vi.mocked(console.error);
      consoleError.mockClear();
      // What Retry calls; keep its promise to see how the retry ends.
      const retry = (fixture.componentInstance as { loadItems(): Promise<void> }).loadItems();
      fixture.destroy();
      succeed([screen.item]);

      // Scheduling focus on the destroyed view would throw NG0911: the retry
      // must neither reject nor report the successful load as a failed one.
      await expect(retry).resolves.toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('gives focus back to Retry when the retry fails again', async () => {
      fetchItems.mockRejectedValue({ statusCode: 500, message: 'Database unavailable' });

      const { fixture, retry } = await renderFailed();
      retry.focus();
      retry.click();

      await waitUntil(fixture, (el) => {
        expect(retryButton(el)).toBeDefined();
        expect(retryButton(el)).not.toBe(retry);
      });
      const element = fixture.nativeElement as HTMLElement;
      expectFailure(element, screen.failure);
      expect(document.activeElement).toBe(retryButton(element));
      expect(fetchItems).toHaveBeenCalledTimes(2);
    });
  });
}
