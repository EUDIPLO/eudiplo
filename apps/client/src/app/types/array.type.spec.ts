import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormGroup } from '@angular/forms';
import { FormlyFieldConfig, FormlyForm, provideFormlyCore } from '@ngx-formly/core';
import { withFormlyMaterial } from '@ngx-formly/material';
import { ArrayTypeComponent } from './array.type';
import { ObjectTypeComponent } from './object.type';

@Component({
  selector: 'app-array-type-host',
  template: `<formly-form [form]="form" [fields]="fields" [model]="model"></formly-form>`,
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FormlyForm],
})
class ArrayTypeHostComponent {
  form = new FormGroup({});
  model: { items?: string[] } = {};
  fields: FormlyFieldConfig[] = [
    {
      key: 'items',
      type: 'array',
      props: { label: 'Items' },
      fieldArray: { type: 'input', props: { label: 'Item' } },
    },
  ];
}

describe('ArrayTypeComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ArrayTypeHostComponent],
      providers: [
        provideFormlyCore([
          ...withFormlyMaterial(),
          {
            types: [
              { name: 'array', component: ArrayTypeComponent },
              { name: 'object', component: ObjectTypeComponent },
            ],
          },
        ]),
      ],
    }).compileComponents();
  });

  it('adds and removes rows of the array', () => {
    const fixture = TestBed.createComponent(ArrayTypeHostComponent);
    const host = fixture.componentInstance;
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;

    expect(element.textContent).toContain('Items');
    expect(element.querySelectorAll('input')).toHaveLength(0);

    const buttonWithIcon = (icon: string) =>
      Array.from(element.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === icon
      )!;

    buttonWithIcon('add').click();
    fixture.detectChanges();

    expect(host.model.items).toHaveLength(1);
    expect(element.querySelectorAll('input')).toHaveLength(1);

    buttonWithIcon('remove').click();
    fixture.detectChanges();

    expect(host.model.items).toHaveLength(0);
    expect(element.querySelectorAll('input')).toHaveLength(0);
  });
});
