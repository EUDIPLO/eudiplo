import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SessionManagementListComponent } from './session-management-list.component';

describe('SessionManagementListComponent', () => {
  let component: SessionManagementListComponent;
  let fixture: ComponentFixture<SessionManagementListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionManagementListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionManagementListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
