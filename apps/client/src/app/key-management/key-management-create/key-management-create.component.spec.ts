import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { KeyManagementCreateComponent } from './key-management-create.component';

describe('KeyManagementCreateComponent', () => {
  let component: KeyManagementCreateComponent;
  let fixture: ComponentFixture<KeyManagementCreateComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KeyManagementCreateComponent],
      providers: [provideRouter([{ path: 'keys/create', children: [] }])],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyManagementCreateComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
