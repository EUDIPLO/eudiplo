import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterLink } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { ItemRoutePipe } from './item-route.pipe';

@Component({
  imports: [RouterLink, ItemRoutePipe],
  template: `
    <a class="show" [routerLink]="id() | itemRoute">Show</a>
    <a class="edit" [routerLink]="id() | itemRoute: 'edit'">Edit</a>
  `,
})
class HostComponent {
  readonly id = input.required<string>();
}

describe('ItemRoutePipe', () => {
  function hrefs(id: string): [string | null, string | null] {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    return [
      page.querySelector('a.show')!.getAttribute('href'),
      page.querySelector('a.edit')!.getAttribute('href'),
    ];
  }

  it('links an ID with a slash as one segment, so it reaches the item and its editor', () => {
    expect(hrefs('team/hook')).toEqual(['/team%2Fhook', '/team%2Fhook/edit']);
  });

  it('leaves a plain ID as it is', () => {
    expect(hrefs('pid')).toEqual(['/pid', '/pid/edit']);
  });
});
