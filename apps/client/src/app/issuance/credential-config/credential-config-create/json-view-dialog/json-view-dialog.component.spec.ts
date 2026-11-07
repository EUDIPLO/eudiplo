import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFieldFocus } from '../../../../common/field-to-fix.util';
import { EditorComponent } from '../../../../utils/editor/editor.component';
import { EditorStub } from '../../../../utils/editor/editor.testing';
import { JsonViewDialogComponent } from './json-view-dialog.component';

describe('JsonViewDialogComponent copy', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  const create = (open = vi.fn()) =>
    new JsonViewDialogComponent(
      {} as never,
      { title: 'Config', jsonData: { id: 'pid' }, readonly: false } as never,
      { open } as never
    );

  it('copies what the editor shows, including edits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const component = create();
    component.jsonControl.setValue('{ "id": "edited" }');

    await component.copyJson();

    expect(writeText).toHaveBeenCalledWith('{ "id": "edited" }');
  });

  it('says to copy the JSON from the editor by hand when nothing was copied', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const open = vi.fn();

    await create(open).copyJson();

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      'Could not copy the JSON. Select it in the editor and copy it by hand.',
      'Close',
      expect.objectContaining({ duration: expect.any(Number) })
    );
  });
});

describe('JsonViewDialogComponent Apply Changes', () => {
  async function render() {
    const close = vi.fn();
    const snackBar = { open: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [JsonViewDialogComponent],
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        {
          provide: MAT_DIALOG_DATA,
          useValue: { title: 'Config', jsonData: { id: 'pid' }, readonly: false },
        },
      ],
    })
      .overrideComponent(JsonViewDialogComponent, {
        remove: { imports: [EditorComponent] },
        add: { imports: [EditorStub] },
      })
      // The component imports MatSnackBarModule, whose provider wins over a root provider.
      .overrideProvider(MatSnackBar, { useValue: snackBar })
      .compileComponents();
    const fixture = TestBed.createComponent(JsonViewDialogComponent);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const apply = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Apply Changes')
    )!;
    // Stands in for the editor's own focus, which puts the focus on Monaco's input.
    const focusEditor = vi.fn();
    registerFieldFocus(page.querySelector('app-editor')!, focusEditor);
    return { fixture, close, snackBar, apply, focusEditor };
  }

  it('says why invalid JSON cannot be applied, focuses the editor and keeps the dialog open', async () => {
    const { fixture, close, snackBar, apply, focusEditor } = await render();
    // The editor reports JSON it cannot parse as `invalidJson`.
    fixture.componentInstance.jsonControl.setErrors({ invalidJson: true });
    fixture.detectChanges();
    expect(apply.disabled).toBe(false);

    apply.click();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Fix the JSON first: it is not valid JSON.',
      'Close',
      expect.anything()
    );
    expect(focusEditor).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('asks for JSON when the editor is empty', async () => {
    const { fixture, close, snackBar, apply, focusEditor } = await render();
    fixture.componentInstance.jsonControl.setValue('');

    apply.click();

    expect(snackBar.open.mock.lastCall?.[0]).toBe('Enter the JSON to apply.');
    expect(focusEditor).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('says why JSON that does not match the schema cannot be applied', async () => {
    const { fixture, close, snackBar, apply, focusEditor } = await render();
    // The editor reports a schema mismatch as `invalidSchema` with its message.
    fixture.componentInstance.jsonControl.setErrors({
      invalidSchema: 'must have required property id',
    });

    apply.click();

    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Fix the JSON first: must have required property id'
    );
    expect(focusEditor).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('applies valid JSON', async () => {
    const { close, apply, focusEditor } = await render();

    apply.click();

    expect(close).toHaveBeenCalledWith({ id: 'pid' });
    expect(focusEditor).not.toHaveBeenCalled();
  });
});
