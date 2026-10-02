import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ClientShowComponent } from './client-show.component';

describe('ClientShowComponent', () => {
  let component: ClientShowComponent;
  let fixture: ComponentFixture<ClientShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ClientShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ClientShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
