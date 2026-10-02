import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';

import { WebhookConfigEditComponent } from './webhook-config-edit.component';

describe('WebhookConfigEditComponent', () => {
  let component: WebhookConfigEditComponent;
  let fixture: ComponentFixture<WebhookConfigEditComponent>;
  let group: FormGroup;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WebhookConfigEditComponent],
    }).compileComponents();

    group = new FormGroup({
      url: new FormControl(''),
      auth: new FormGroup({
        type: new FormControl('none'),
        config: new FormGroup({
          headerName: new FormControl(''),
          value: new FormControl(''),
        }),
      }),
    });

    fixture = TestBed.createComponent(WebhookConfigEditComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('group', group);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('requires the api key header fields when the auth type is apiKey', () => {
    group.get('auth.type')?.setValue('apiKey');

    expect(group.get('auth.config.headerName')?.hasError('required')).toBe(true);
    expect(group.get('auth.config.value')?.hasError('required')).toBe(true);
  });
});
