import { ApplicationRef, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { focusIfFocusWasLost, focusRowAfterRemoval } from './focus-if-lost.util';
import { loseFocus } from './settings-screen.testing';

describe('focusIfFocusWasLost', () => {
  const added: HTMLElement[] = [];

  function focusable(tag = 'button'): HTMLElement {
    const element = document.body.appendChild(document.createElement(tag));
    added.push(element);
    return element;
  }

  afterEach(() => added.splice(0).forEach((element) => element.remove()));

  it('focuses the target when focus fell back to the body', () => {
    const target = focusable();
    loseFocus();

    focusIfFocusWasLost(target);

    expect(document.activeElement).toBe(target);
  });

  it('focuses the target when focus is still on the control it leaves', () => {
    const target = focusable();
    const from = focusable();
    from.focus();

    focusIfFocusWasLost(target, from);

    expect(document.activeElement).toBe(target);
  });

  it('leaves focus the user moved elsewhere', () => {
    const target = focusable();
    const from = focusable();
    const elsewhere = focusable('input');
    elsewhere.focus();

    focusIfFocusWasLost(target, from);

    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('focusRowAfterRemoval', () => {
  const added: HTMLElement[] = [];

  function focusable(): HTMLElement {
    const element = document.body.appendChild(document.createElement('button'));
    added.push(element);
    return element;
  }

  afterEach(() => added.splice(0).forEach((element) => element.remove()));

  /** Removes the row at `index` from `rows` while it holds focus, then renders. */
  function removeFocusedRow(rows: HTMLElement[], index: number, fallback?: HTMLElement): void {
    const [removed] = rows.splice(index, 1);
    removed.focus();
    removed.remove();
    loseFocus();
    focusRowAfterRemoval(
      TestBed.inject(Injector),
      () => rows,
      index,
      () => fallback
    );
    TestBed.inject(ApplicationRef).tick();
  }

  it('focuses the row now in the place of the removed one', () => {
    const rows = [focusable(), focusable(), focusable()];
    const next = rows[2];

    removeFocusedRow(rows, 1);

    expect(document.activeElement).toBe(next);
  });

  it('focuses the new last row when the last row was removed', () => {
    const rows = [focusable(), focusable()];
    const first = rows[0];

    removeFocusedRow(rows, 1);

    expect(document.activeElement).toBe(first);
  });

  it('focuses the fallback when no row is left', () => {
    const rows = [focusable()];
    const add = focusable();

    removeFocusedRow(rows, 0, add);

    expect(document.activeElement).toBe(add);
  });
});
