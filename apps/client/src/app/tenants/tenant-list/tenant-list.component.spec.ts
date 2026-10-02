import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { TenantListComponent } from './tenant-list.component';

describe('TenantListComponent', () => {
  let component: TenantListComponent;
  let fixture: ComponentFixture<TenantListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TenantListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TenantListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
