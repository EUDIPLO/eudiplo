import type { ComponentFixture } from '@angular/core/testing';
import { expect } from 'vitest';
import { expectUnavailable, tooltipOf } from './unavailable-action.testing';

/** Test helpers for the tenant settings screens with Save and Reset to Defaults. */

export function findButton(element: HTMLElement, label: string): HTMLButtonElement {
  const found = [...element.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

/** The tooltip of a button, which screen readers also read as its description. */
export function buttonTooltip(fixture: ComponentFixture<unknown>, label: string): string {
  return tooltipOf(fixture, findButton(fixture.nativeElement as HTMLElement, label));
}

/** Reset to Defaults looks disabled but stays focusable, so its tooltip can say why. */
export function expectResetUnavailable(fixture: ComponentFixture<unknown>, reason: string): void {
  const reset = findButton(fixture.nativeElement as HTMLElement, 'Reset to Defaults');
  expectUnavailable(fixture, reset, reason);
}

export function expectResetAvailable(fixture: ComponentFixture<unknown>): void {
  const reset = findButton(fixture.nativeElement as HTMLElement, 'Reset to Defaults');
  expect(reset.disabled).toBe(false);
  expect(reset.getAttribute('aria-disabled')).toBeNull();
  expect(buttonTooltip(fixture, 'Reset to Defaults')).toBe('Reset to global defaults');
}

export const NOTHING_TO_RESET = 'Nothing to reset: this tenant already follows the global defaults';
export const RESET_WHILE_SAVING = 'Wait until the current change has finished';

/**
 * Leaves focus on `<body>`, where a browser leaves it when the focused element
 * is removed or disabled. jsdom does not move focus off a disabled button, and
 * does not blur one either.
 */
export function loseFocus(): void {
  const placeholder = document.body.appendChild(document.createElement('input'));
  placeholder.focus();
  placeholder.remove();
}
