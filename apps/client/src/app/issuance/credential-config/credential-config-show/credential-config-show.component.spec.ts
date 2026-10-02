import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { CredentialConfigShowComponent } from './credential-config-show.component';

describe('CredentialConfigShowComponent', () => {
  let component: CredentialConfigShowComponent;
  let fixture: ComponentFixture<CredentialConfigShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CredentialConfigShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(CredentialConfigShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
