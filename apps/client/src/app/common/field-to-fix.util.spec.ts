import { ApplicationRef, Component, EventEmitter, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import type { MatExpansionPanel } from '@angular/material/expansion';
import type { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fieldsToFixMessage,
  firstFieldWithError,
  firstInvalidField,
  focusField,
  focusFieldToFix,
  registerFieldFocus,
  sectionsWithErrors,
  showFieldsToFix,
} from './field-to-fix.util';

/** A form in the document whose markup is `html`, removed after each test. */
let form: HTMLFormElement | undefined;
function render(html: string): HTMLFormElement {
  form = document.body.appendChild(document.createElement('form'));
  form.innerHTML = html;
  return form;
}
const byName = (name: string) => form!.querySelector<HTMLElement>(`[formcontrolname="${name}"]`)!;

/** Runs the render hooks of the application, as change detection does after an event. */
const render$ = () => TestBed.inject(ApplicationRef).tick();

afterEach(() => {
  form?.remove();
  form = undefined;
});

describe('firstInvalidField', () => {
  it('finds the first invalid field in the order of the page', () => {
    const container = render(`
      <input formcontrolname="id" class="ng-valid" />
      <div formgroupname="contact" class="ng-invalid">
        <input formcontrolname="email" class="ng-invalid" />
      </div>
      <input formcontrolname="name" class="ng-invalid" />
    `);

    expect(firstInvalidField(container)).toBe(byName('email'));
  });

  it('finds nothing when every field is valid, or without a container', () => {
    const container = render(`<input formcontrolname="id" class="ng-valid" />`);
    container.classList.add('ng-invalid');

    expect(firstInvalidField(container)).toBeUndefined();
    expect(firstInvalidField(undefined)).toBeUndefined();
  });
});

describe('firstFieldWithError', () => {
  it('also finds a field bound with [formControl] and one that shows another control’s error', () => {
    const container = render(`
      <input formcontrolname="id" class="ng-valid" />
      <mat-select id="import" aria-invalid="true"></mat-select>
      <input id="claim" class="ng-invalid" />
      <input formcontrolname="name" class="ng-invalid" />
    `);
    const field = (id: string) => container.querySelector<HTMLElement>(`#${id}`);

    expect(firstFieldWithError(container)).toBe(field('import'));
    field('import')!.removeAttribute('aria-invalid');
    expect(firstFieldWithError(container)).toBe(field('claim'));
    field('claim')!.classList.replace('ng-invalid', 'ng-valid');
    expect(firstFieldWithError(container)).toBe(byName('name'));
  });

  it('skips groups, which are invalid when a field in them is', () => {
    const container = render(`
      <div class="ng-invalid"><mat-select id="provider" class="ng-invalid"></mat-select></div>
      <mat-checkbox id="consent" class="ng-invalid"></mat-checkbox>
    `);

    expect(firstFieldWithError(container)?.id).toBe('provider');
    container.querySelector('#provider')!.classList.replace('ng-invalid', 'ng-valid');
    expect(firstFieldWithError(container)?.id).toBe('consent');
  });

  it('finds a textarea and a radio group bound with [formControl], in page order', () => {
    const container = render(`
      <textarea id="notes" class="ng-invalid"></textarea>
      <mat-radio-group id="level" class="ng-invalid"></mat-radio-group>
    `);

    expect(firstFieldWithError(container)?.id).toBe('notes');
    container.querySelector('#notes')!.classList.replace('ng-invalid', 'ng-valid');
    expect(firstFieldWithError(container)?.id).toBe('level');
  });

  it('skips a disabled field that only shows the error of another control', () => {
    const container = render(`
      <mat-select id="trust-lists" aria-invalid="true" aria-disabled="true"></mat-select>
      <textarea formcontrolname="value" class="ng-invalid"></textarea>
    `);

    expect(firstFieldWithError(container)).toBe(byName('value'));
    expect(firstFieldWithError(undefined)).toBeUndefined();
  });
});

describe('focusField', () => {
  it('focuses a field that can take the focus', () => {
    render(`<input formcontrolname="id" />`);

    focusField(byName('id'));

    expect(document.activeElement).toBe(byName('id'));
  });

  it('focuses the first element inside a field that cannot take the focus itself', () => {
    render(`<mat-checkbox formcontrolname="enabled"><input type="checkbox" /></mat-checkbox>`);

    focusField(byName('enabled'));

    expect(document.activeElement).toBe(form!.querySelector('input'));
  });

  it('focuses a field by the focus registered for it, until that is undone', () => {
    render(`<app-editor formcontrolname="jwks"><textarea></textarea></app-editor>`);
    const editor = byName('jwks');
    const focus = vi.fn();

    const unregister = registerFieldFocus(editor, focus);
    focusField(editor);
    expect(focus).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(form!.querySelector('textarea'));

    unregister();
    focusField(editor);
    expect(focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(form!.querySelector('textarea'));
  });
});

describe('focusFieldToFix', () => {
  /** A panel that is opening: `expanded` is set, the transition has not ended yet. */
  function openingPanel() {
    return {
      expanded: true,
      afterExpand: new EventEmitter<void>(),
      closed: new EventEmitter<void>(),
    };
  }
  const asPanel = (panel: ReturnType<typeof openingPanel>) => panel as unknown as MatExpansionPanel;

  /** Makes `field` refuse the next focus, as a browser does while a panel still hides it. */
  function refuseNextFocus(field: HTMLElement): void {
    const focus = field.focus.bind(field);
    field.focus = () => {
      field.focus = focus;
    };
  }

  it('focuses the first invalid field once the page has rendered', () => {
    const container = render(`
      <input formcontrolname="id" class="ng-valid" />
      <input formcontrolname="name" class="ng-invalid" />
    `);

    focusFieldToFix(TestBed.inject(Injector), () => container);
    expect(document.activeElement).not.toBe(byName('name'));
    render$();

    expect(document.activeElement).toBe(byName('name'));
  });

  it('focuses the fallback when no field is invalid', () => {
    const container = render(`
      <input formcontrolname="id" class="ng-valid" />
      <button type="button">Add Entity</button>
    `);
    const add = container.querySelector('button')!;

    focusFieldToFix(TestBed.inject(Injector), () => container, { fallback: () => add });
    render$();

    expect(document.activeElement).toBe(add);
  });

  it('focuses the given field instead of the first invalid one', () => {
    const container = render(`
      <input formcontrolname="url" class="ng-invalid" />
      <input formcontrolname="email" class="ng-invalid" />
    `);

    focusFieldToFix(TestBed.inject(Injector), () => container, { field: () => byName('email') });
    render$();

    expect(document.activeElement).toBe(byName('email'));
  });

  it('focuses the first invalid field when the given field is not found', () => {
    const container = render(`
      <input formcontrolname="url" class="ng-invalid" />
      <input formcontrolname="email" class="ng-invalid" />
    `);

    focusFieldToFix(TestBed.inject(Injector), () => container, { field: () => null });
    render$();

    expect(document.activeElement).toBe(byName('url'));
  });

  it('focuses a field its opening panel still hides once the panel has expanded', () => {
    const container = render(`
      <button type="submit">Save</button>
      <input formcontrolname="name" class="ng-invalid" />
    `);
    const save = container.querySelector('button')!;
    const panel = openingPanel();
    save.focus();
    refuseNextFocus(byName('name'));

    focusFieldToFix(TestBed.inject(Injector), () => container, { panel: asPanel(panel) });
    render$();
    expect(document.activeElement).toBe(save);

    panel.afterExpand.emit();
    expect(document.activeElement).toBe(byName('name'));
  });

  it('leaves focus the user moved while the panel was opening', () => {
    const container = render(`
      <button type="submit">Save</button>
      <input formcontrolname="name" class="ng-invalid" />
      <input formcontrolname="other" />
    `);
    const panel = openingPanel();
    container.querySelector('button')!.focus();
    refuseNextFocus(byName('name'));

    focusFieldToFix(TestBed.inject(Injector), () => container, { panel: asPanel(panel) });
    render$();
    byName('other').focus();
    panel.afterExpand.emit();

    expect(document.activeElement).toBe(byName('other'));
  });

  it('leaves the focus alone when the panel closes before it has expanded, then and later', () => {
    const container = render(`
      <button type="submit">Save</button>
      <input formcontrolname="name" class="ng-invalid" />
    `);
    const save = container.querySelector('button')!;
    const panel = openingPanel();
    save.focus();
    refuseNextFocus(byName('name'));

    focusFieldToFix(TestBed.inject(Injector), () => container, { panel: asPanel(panel) });
    render$();
    panel.closed.emit();
    panel.afterExpand.emit();

    expect(document.activeElement).toBe(save);
  });

  it('does nothing once the component it belongs to is destroyed', () => {
    const container = render(`<input formcontrolname="name" class="ng-invalid" />`);
    @Component({ template: '' })
    class LeftPage {}
    const page = TestBed.createComponent(LeftPage);
    const injector = page.componentRef.injector;
    page.destroy();

    focusFieldToFix(injector, () => container);
    render$();

    expect(document.activeElement).not.toBe(byName('name'));
  });
});

describe('sectionsWithErrors and fieldsToFixMessage', () => {
  it('names the sections that hold an invalid control, in the order given', () => {
    const name = new FormControl('', Validators.required);
    const url = new FormControl('x');
    const header = new FormControl('', Validators.required);

    const sections = sectionsWithErrors([
      { name: 'Endpoint Details', controls: [name, url] },
      { name: 'Options', controls: [url, null] },
      { name: 'Authentication', controls: [header] },
    ]);

    expect(sections).toEqual(['Endpoint Details', 'Authentication']);
    expect(fieldsToFixMessage(sections)).toBe(
      'Check the highlighted fields in Endpoint Details, Authentication.'
    );
  });

  it('asks to check the highlighted fields when no section is named', () => {
    expect(fieldsToFixMessage([])).toBe('Check the highlighted fields.');
  });
});

describe('showFieldsToFix', () => {
  it('shows every error, names the sections and focuses the first invalid field', () => {
    const container = render(`<input formcontrolname="ttl" class="ng-invalid" />`);
    const ttl = new FormControl(5, Validators.min(60));
    const group = new FormGroup({ ttl, mode: new FormControl('') });
    const snackBar = { open: vi.fn() };

    showFieldsToFix(group, {
      snackBar: snackBar as unknown as MatSnackBar,
      injector: TestBed.inject(Injector),
      container: () => container,
      sections: [
        { name: 'Cleanup Mode', controls: [group.controls.mode] },
        { name: 'Session Time-to-Live (TTL)', controls: [ttl] },
      ],
    });
    render$();

    expect(ttl.touched).toBe(true);
    expect(group.controls.mode.touched).toBe(true);
    expect(snackBar.open).toHaveBeenCalledWith(
      'Check the highlighted fields in Session Time-to-Live (TTL).',
      'Close',
      expect.objectContaining({ duration: expect.any(Number) })
    );
    expect(document.activeElement).toBe(byName('ttl'));
  });
});
