import { Component, forwardRef, Input } from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';

/**
 * Stands in for the Monaco editor, which needs a browser, in specs of screens
 * that show one: replace `EditorComponent` with it in the component's imports.
 */
@Component({
  selector: 'app-editor',
  template: '',
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => EditorStub), multi: true },
  ],
})
export class EditorStub implements ControlValueAccessor {
  @Input() schema: unknown;
  @Input() editorOptions: unknown;
  @Input() errors: unknown;
  writeValue(): void {}
  registerOnChange(): void {}
  registerOnTouched(): void {}
}
