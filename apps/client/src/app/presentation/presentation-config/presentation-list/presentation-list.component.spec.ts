import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { PresentationListComponent } from './presentation-list.component';

describe('PresentationListComponent', () => {
  let component: PresentationListComponent;
  let fixture: ComponentFixture<PresentationListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(PresentationListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
