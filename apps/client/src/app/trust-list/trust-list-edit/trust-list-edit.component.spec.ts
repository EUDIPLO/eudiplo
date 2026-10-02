import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { TrustListEditComponent } from './trust-list-edit.component';

describe('TrustListEditComponent', () => {
  let component: TrustListEditComponent;
  let fixture: ComponentFixture<TrustListEditComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrustListEditComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TrustListEditComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
