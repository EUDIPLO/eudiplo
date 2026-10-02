import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SessionManagementShowComponent } from './session-management-show.component';

describe('SessionManagementShowComponent', () => {
  let component: SessionManagementShowComponent;
  let fixture: ComponentFixture<SessionManagementShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionManagementShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionManagementShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
