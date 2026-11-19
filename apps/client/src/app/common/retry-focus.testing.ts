import { ApplicationRef } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { expect, vi } from 'vitest';

import { findButton, loseFocus } from './settings-screen.testing';

/**
 * Checks where focus goes on an edit screen that shows `<app-load-error>` when the resource to
 * edit cannot be loaded. Set up the load to succeed, fail and succeed again, in that order.
 *
 * The first load (`fixture.detectChanges()`, which runs `ngOnInit`) succeeds and leaves focus
 * alone. `reload` loads again and fails. The Retry button then loads successfully, which removes
 * the card with the focused button, so focus moves to the page heading, `h2` unless `heading`
 * names another selector, such as `h1` on the restyled forms.
 */
export async function expectHeadingFocusOnlyAfterRetry(
  fixture: ComponentFixture<unknown>,
  reload: () => void,
  loaded: () => boolean,
  heading = 'h2'
): Promise<void> {
  const page = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await vi.waitFor(() => expect(loaded()).toBe(true));
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
  };
  const headingElement = page.querySelector<HTMLElement>(heading)!;

  loseFocus();
  fixture.detectChanges();
  await settle();
  expect(headingElement.tabIndex).toBe(-1);
  expect(document.activeElement).not.toBe(headingElement);

  reload();
  await settle();
  const retry = findButton(page, 'Retry');

  retry.focus();
  retry.click();
  await settle();
  expect(page.querySelector('app-load-error')).toBeNull();
  expect(document.activeElement).toBe(headingElement);
}
