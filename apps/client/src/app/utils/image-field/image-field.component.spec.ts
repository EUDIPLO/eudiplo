import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';

import { ImageFieldComponent } from './image-field.component';

describe('ImageFieldComponent', () => {
  let component: ImageFieldComponent;
  let fixture: ComponentFixture<ImageFieldComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ImageFieldComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ImageFieldComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('field', new FormControl('', { nonNullable: true }));
    fixture.componentRef.setInput('label', 'Logo');
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
