import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { TrustListListComponent } from './trust-list-list.component';

describe('TrustListListComponent', () => {
  let component: TrustListListComponent;
  let fixture: ComponentFixture<TrustListListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrustListListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TrustListListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
