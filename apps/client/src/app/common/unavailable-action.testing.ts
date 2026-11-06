import type { ComponentFixture } from '@angular/core/testing';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { expect } from 'vitest';

/** Test helpers for an action that stays focusable while it cannot be used. */

/** The Material tooltip of `element`, which screen readers also read as its description. */
export function tooltipOf(fixture: ComponentFixture<unknown>, element: Element): string {
  const host = fixture.debugElement
    .queryAll(By.directive(MatTooltip))
    .find((candidate) => candidate.nativeElement === element);
  if (!host) throw new Error('The element has no matTooltip');
  return host.injector.get(MatTooltip).message;
}

/**
 * `button` looks disabled but keeps the focus and can be reached with Tab
 * (`disabledInteractive`), and its tooltip says why it cannot be used.
 */
export function expectUnavailable(
  fixture: ComponentFixture<unknown>,
  button: HTMLButtonElement,
  reason: string
): void {
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(tooltipOf(fixture, button)).toBe(reason);
}

/**
 * `button` can be used and has no reason to give: its tooltip is empty, or
 * `description` for a button whose tooltip names its action.
 */
export function expectAvailable(
  fixture: ComponentFixture<unknown>,
  button: HTMLButtonElement,
  description = ''
): void {
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBeNull();
  expect(tooltipOf(fixture, button)).toBe(description);
}
