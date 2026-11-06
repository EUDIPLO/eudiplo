import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideMonacoEditor } from 'ngx-monaco-editor-v2';

import { focusField } from '../../common/field-to-fix.util';
import { EditorComponent } from './editor.component';
import { transactionDataArraySchema } from '../schemas';

describe('EditorComponent', () => {
  let component: EditorComponent;
  let fixture: ComponentFixture<EditorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EditorComponent],
      providers: [provideMonacoEditor()],
    }).compileComponents();

    fixture = TestBed.createComponent(EditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('validates a transaction data array with its supplied schema', () => {
    fixture.componentRef.setInput('schema', transactionDataArraySchema);
    fixture.detectChanges();
    component.writeValue([{ type: 'payment', credential_ids: ['pid'], amount: 100 }]);

    expect(component.validate()).toBeNull();
  });

  describe('focus', () => {
    /** Stands in for the Monaco editor, which does not load under jsdom. */
    const monaco = () => ({
      focus: vi.fn(),
      onDidChangeModelDecorations: () => ({ dispose: () => undefined }),
    });

    it('moves focus into Monaco', () => {
      const editor = monaco();
      component.onEditorInit(editor);

      component.focus();

      expect(editor.focus).toHaveBeenCalledTimes(1);
    });

    it('focuses Monaco once it has loaded when asked before', () => {
      component.focus();
      const editor = monaco();

      component.onEditorInit(editor);

      expect(editor.focus).toHaveBeenCalledTimes(1);
    });

    it('leaves the focus the user moved while Monaco was loading', () => {
      component.focus();
      const elsewhere = document.body.appendChild(document.createElement('button'));
      elsewhere.focus();
      const editor = monaco();

      component.onEditorInit(editor);

      expect(editor.focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("is how a form's Save focuses the field, until the editor is destroyed", () => {
      const editor = monaco();
      component.onEditorInit(editor);
      const host = fixture.nativeElement as HTMLElement;

      focusField(host);
      expect(editor.focus).toHaveBeenCalledTimes(1);

      fixture.destroy();
      focusField(host);
      expect(editor.focus).toHaveBeenCalledTimes(1);
    });
  });
});
