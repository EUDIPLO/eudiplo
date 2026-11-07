import { afterNextRender, DestroyRef, type Injector } from '@angular/core';

/**
 * Whether focus has fallen back to `<body>`, for example because the focused
 * control was removed with the content it belonged to, or is still on `from`,
 * a control that can no longer be used. False when the user has moved it
 * elsewhere in the meantime.
 */
export function focusWasLost(from?: Element | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || (!!from && active === from);
}

/**
 * Focuses `element` when focus was lost (see `focusWasLost`). Focus the user
 * has moved elsewhere in the meantime stays where it is.
 */
export function focusIfFocusWasLost(element: HTMLElement | undefined, from?: HTMLElement): void {
  if (focusWasLost(from)) {
    element?.focus();
  }
}

/**
 * Calls `focusIfFocusWasLost` after the next render, when content shown by
 * the change that just happened exists. Nothing happens once the component
 * behind `injector` is destroyed, for example because the user left the page
 * while a request was running.
 */
export function focusAfterRenderIfLost(
  injector: Injector,
  element: () => HTMLElement | undefined,
  from?: () => HTMLElement | undefined
): void {
  if (injector.get(DestroyRef).destroyed) return;
  afterNextRender(() => focusIfFocusWasLost(element(), from?.()), { injector });
}

/**
 * After a row of a list was removed, focuses the row now at its `index`, the new last row when
 * the removed row was the last one, or `fallback` when no row is left. Like
 * `focusAfterRenderIfLost`, it leaves focus the user has moved elsewhere.
 */
export function focusRowAfterRemoval(
  injector: Injector,
  rows: () => readonly HTMLElement[] | undefined,
  index: number,
  fallback?: () => HTMLElement | undefined
): void {
  focusAfterRenderIfLost(injector, () => {
    const remaining = rows() ?? [];
    return remaining[Math.min(index, remaining.length - 1)] ?? fallback?.();
  });
}
