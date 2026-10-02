import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';

import { CredentialIdsComponent } from './credential-ids.component';

describe('CredentialIdsComponent', () => {
  let component: CredentialIdsComponent;
  let fixture: ComponentFixture<CredentialIdsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CredentialIdsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CredentialIdsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput(
      'formGroup',
      new FormGroup({
        format: new FormControl(''),
        data: new FormControl(''),
        credential_ids: new FormControl<string[]>(['pid']),
      })
    );
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('initializes the credential ids from the form group', () => {
    expect(component.credentialIds()).toEqual(['pid']);
  });
});
