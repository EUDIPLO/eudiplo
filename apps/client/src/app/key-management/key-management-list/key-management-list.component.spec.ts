import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { KeyManagementListComponent } from './key-management-list.component';

describe('KeyManagementListComponent', () => {
  let component: KeyManagementListComponent;
  let fixture: ComponentFixture<KeyManagementListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KeyManagementListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyManagementListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
