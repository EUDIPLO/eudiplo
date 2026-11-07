import { afterNextRender, DestroyRef, type Injector } from '@angular/core';
import type { AbstractControl } from '@angular/forms';
import type { MatExpansionPanel } from '@angular/material/expansion';
import type { MatSnackBar } from '@angular/material/snack-bar';
import { map, merge, take } from 'rxjs';

import { openErrorSnackBar } from '../utils/error-snackbar';
import { focusWasLost } from './focus-if-lost.util';

/**
 * Helpers for a Save that stays usable while fields are invalid and, when clicked then, says what
 * keeps the form from saving (see the paragraph on a form's Save in contributing/client.md).
 */

/** How to focus a field whose host element is not focusable itself, by that element. */
const fieldFocusers = new WeakMap<Element, () => void>();

/**
 * Lets `focusField` focus `field`, a host element that cannot take the focus itself, by calling
 * `focus`, as `app-editor` does for Monaco's input inside it. Returns the function that undoes it.
 */
export function registerFieldFocus(field: Element, focus: () => void): () => void {
  fieldFocusers.set(field, focus);
  return () => {
    if (fieldFocusers.get(field) === focus) fieldFocusers.delete(field);
  };
}

/** The elements inside a field that can take the focus, such as the input of a checkbox. */
const FOCUSABLE =
  'input:not([type="hidden"]), select, textarea, button, [tabindex]:not([tabindex="-1"])';

/**
 * Focuses `field`: by the focus registered for it (see `registerFieldFocus`), else the field
 * itself, else the first element inside it that can take the focus.
 */
export function focusField(field: HTMLElement): void {
  const focus = fieldFocusers.get(field);
  if (focus) {
    focus();
    return;
  }
  field.focus();
  if (!field.contains(document.activeElement)) {
    field.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }
}

/** The first field in `container`, in the order of the page, whose control is invalid. */
export function firstInvalidField(
  container: ParentNode | null | undefined
): HTMLElement | undefined {
  return container?.querySelector<HTMLElement>('[formcontrolname].ng-invalid') ?? undefined;
}

/**
 * Fields that `firstInvalidField` misses: a field bound with `[formControl]`, as formly binds its
 * fields, and a Material control that shows the error of other controls through its
 * `errorStateMatcher`, which marks it `aria-invalid`, unless it is disabled and so cannot fix it.
 */
const FIELD_WITH_ERROR = [
  '[formcontrolname].ng-invalid',
  'input.ng-invalid',
  'textarea.ng-invalid',
  'mat-select.ng-invalid',
  'mat-checkbox.ng-invalid',
  'mat-radio-group.ng-invalid',
  '[aria-invalid="true"]:not([aria-disabled="true"])',
].join(', ');

/**
 * The first field in `container`, in the order of the page, that is invalid or shows an error: as
 * `firstInvalidField`, and also a field bound with `[formControl]` or one that shows the error of
 * other controls, such as a select that fills a required list. A form with such fields passes
 * `field: () => firstFieldWithError(container())`.
 */
export function firstFieldWithError(
  container: ParentNode | null | undefined
): HTMLElement | undefined {
  return container?.querySelector<HTMLElement>(FIELD_WITH_ERROR) ?? undefined;
}

export interface FocusFieldToFixOptions {
  /**
   * The expansion panel just opened to show the field. Its content stays hidden for the first
   * frame of the opening transition, and a browser refuses the focus then.
   */
  readonly panel?: MatExpansionPanel;
  /** Takes the focus when no field is invalid, such as the Add button of a list that is empty. */
  readonly fallback?: () => HTMLElement | null | undefined;
  /**
   * The field to focus instead of the first invalid one: in a form in which some errors do not
   * keep it from saving, such as a backend rejection that saving again checks anew, the first
   * field that does; in a form with fields that `firstInvalidField` misses, `firstFieldWithError`.
   */
  readonly field?: () => HTMLElement | null | undefined;
}

/**
 * After the next render, moves focus to `field`, else to the first invalid field in `container`
 * (see `firstInvalidField`), else to `fallback`. When `panel` still hides the field, the field takes
 * the focus once the panel has expanded, unless the panel closed first or the user has moved the
 * focus meanwhile. Nothing happens once the component behind `injector` is destroyed.
 */
export function focusFieldToFix(
  injector: Injector,
  container: () => ParentNode | null | undefined,
  { panel, fallback, field: fieldToFocus }: FocusFieldToFixOptions = {}
): void {
  if (injector.get(DestroyRef).destroyed) return;
  afterNextRender(
    () => {
      const field = fieldToFocus?.() ?? firstInvalidField(container()) ?? fallback?.() ?? undefined;
      if (!field) return;
      const from = document.activeElement;
      focusField(field);
      // A field such as `app-editor` puts the focus on an element inside it.
      if (field.contains(document.activeElement) || !panel?.expanded) return;
      merge(panel.afterExpand.pipe(map(() => true)), panel.closed.pipe(map(() => false)))
        .pipe(take(1))
        .subscribe((expanded) => {
          if (expanded && focusWasLost(from)) focusField(field);
        });
    },
    { injector }
  );
}

/** A part of a form, by the name the page gives it, with the controls of its fields. */
export interface FormSection {
  readonly name: string;
  readonly controls: readonly (AbstractControl | null | undefined)[];
}

/** The names of the sections that hold an invalid control, in the order given. */
export function sectionsWithErrors(sections: readonly FormSection[]): string[] {
  return sections
    .filter((section) => section.controls.some((control) => control?.invalid))
    .map((section) => section.name);
}

/** What the snackbar says about invalid fields: the sections that hold them, when named. */
export function fieldsToFixMessage(sections: readonly string[]): string {
  return sections.length
    ? `Check the highlighted fields in ${sections.join(', ')}.`
    : 'Check the highlighted fields.';
}

export interface ShowFieldsToFixOptions extends FocusFieldToFixOptions {
  readonly snackBar: MatSnackBar;
  readonly injector: Injector;
  /** The element that holds the form's fields. */
  readonly container: () => ParentNode | null | undefined;
  /** The parts of the form the snackbar names when they hold an invalid field. */
  readonly sections?: readonly FormSection[];
}

/**
 * Says what keeps `form` from saving: marks every field touched, so that each shows its error,
 * names the sections that hold one in a snackbar and moves focus to the first invalid field, as
 * `focusFieldToFix` does. The caller opens a collapsed section that holds that field first.
 */
export function showFieldsToFix(form: AbstractControl, options: ShowFieldsToFixOptions): void {
  form.markAllAsTouched();
  openErrorSnackBar(
    options.snackBar,
    fieldsToFixMessage(sectionsWithErrors(options.sections ?? []))
  );
  focusFieldToFix(options.injector, options.container, options);
}
