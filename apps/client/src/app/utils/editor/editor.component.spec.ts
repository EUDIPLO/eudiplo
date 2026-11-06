import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMonacoEditor } from 'ngx-monaco-editor-v2';

import { EditorComponent } from './editor.component';
import { credentialConfigSchema, SchemaValidation, transactionDataArraySchema } from '../schemas';

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

  it('explains a pattern error with the field description instead of the pattern', () => {
    fixture.componentRef.setInput('schema', credentialConfigSchema);
    fixture.detectChanges();
    component.writeValue({
      id: 'pid',
      config: {
        format: 'dc+sd-jwt',
        display: [{ name: 'PID', locale: 'en-US', text_color: 'navy' }],
      },
      fields: [],
    });

    const message = component.validate()?.['invalidSchema'] as string;
    expect(message).toContain('config.display.0.text_color has the wrong format.');
    expect(message).toContain('CSS Color Level 3');
    expect(message).not.toContain('^(?:');
  });

  it('keeps the pattern of a short one, which says which characters fit', () => {
    fixture.componentRef.setInput(
      'schema',
      new SchemaValidation({
        $id: 'https://example.com/short-pattern.schema.json',
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-z]+$', description: 'Identifier.' } },
      })
    );
    fixture.detectChanges();
    component.writeValue({ id: 'A1' });

    expect(component.validate()?.['invalidSchema']).toBe('id must match pattern "^[a-z]+$"');
  });
});
