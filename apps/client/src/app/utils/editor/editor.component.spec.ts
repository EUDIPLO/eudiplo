import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMonacoEditor } from 'ngx-monaco-editor-v2';

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
});
