import { Subject } from 'rxjs';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type FederationTrustAnchor,
  FederationTrustAnchorService,
} from '../federation-trust-anchor.service';
import { FederationTrustAnchorSelectComponent } from './federation-trust-anchor-select.component';

const anchor: FederationTrustAnchor = {
  id: 'eu-federation',
  tenantId: 'tenant',
  entityId: 'https://ta.example',
  description: 'EU federation',
  jwks: { keys: [] },
};

@Component({
  imports: [ReactiveFormsModule, FederationTrustAnchorSelectComponent],
  template: `<app-federation-trust-anchor-select
    [formControl]="control"
    (anchorSelected)="selected = $event"
  />`,
})
class HostComponent {
  readonly control = new FormControl('', { nonNullable: true, validators: Validators.required });
  selected?: { anchor: FederationTrustAnchor; previous: string };
}

describe('FederationTrustAnchorSelectComponent', () => {
  async function render(value: string, registeredAnchors: ReturnType<typeof vi.fn>) {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        {
          provide: FederationTrustAnchorService,
          useValue: { registeredAnchors, loaded: new Subject() },
        },
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.control.setValue(value);
    fixture.detectChanges();
    const select = fixture.debugElement.children[0]
      .componentInstance as FederationTrustAnchorSelectComponent;
    await vi.waitFor(() => expect(select.loading).toBe(false));
    fixture.detectChanges();
    return { fixture, select, element: fixture.nativeElement as HTMLElement };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the picked entity ID to the form and reports the trust anchor', async () => {
    const { fixture, select, element } = await render('', vi.fn().mockResolvedValue([anchor]));

    select.selection.setValue('https://ta.example');

    expect(fixture.componentInstance.control.value).toBe('https://ta.example');
    expect(fixture.componentInstance.control.touched).toBe(true);
    expect(fixture.componentInstance.selected).toEqual({ anchor, previous: '' });
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps an unregistered entity ID, flags it and links its registration', async () => {
    const { element, select } = await render(
      'https://unknown.example',
      vi.fn().mockResolvedValue([anchor])
    );

    expect(select.unregistered).toBe(true);
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      'https://unknown.example is not a registered trust anchor'
    );
    const link = element.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(link.getAttribute('href')).toBe(
      '/federation-trust-anchor/create?entityId=https:%2F%2Funknown.example&from=form'
    );
  });

  it('opens the registration as one for this form, so that page says to return here', async () => {
    const { element } = await render('https://ta.example', vi.fn().mockResolvedValue([anchor]));

    const link = element.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(link.getAttribute('href')).toBe('/federation-trust-anchor/create?from=form');
  });

  it('reloads the list when the user comes back from registering one', async () => {
    const registeredAnchors = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([anchor]);
    const { fixture, select, element } = await render('https://ta.example', registeredAnchors);
    expect(select.unregistered).toBe(true);

    element
      .querySelector<HTMLAnchorElement>('a[target="_blank"]')!
      .dispatchEvent(new MouseEvent('click', { ctrlKey: true, cancelable: true }));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(registeredAnchors).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(select.unregistered).toBe(false));
    fixture.detectChanges();

    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports a failed load, keeps the value and loads again on Retry', async () => {
    const registeredAnchors = vi
      .fn()
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValue([anchor]);
    const { fixture, select, element } = await render('https://ta.example', registeredAnchors);

    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Database unavailable');
    expect(select.unregistered).toBe(false);
    expect(fixture.componentInstance.control.value).toBe('https://ta.example');

    element
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Retry loading trust anchors for Trust anchor"]'
      )!
      .click();
    await vi.waitFor(() => expect(select.loaded).toBe(true));
    expect(registeredAnchors).toHaveBeenLastCalledWith(true);
  });

  it('shows a list another picker of the page loaded', async () => {
    const loaded = new Subject<FederationTrustAnchor[]>();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        {
          provide: FederationTrustAnchorService,
          useValue: { registeredAnchors: vi.fn().mockResolvedValue([]), loaded },
        },
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.control.setValue('https://ta.example');
    fixture.detectChanges();
    const select = fixture.debugElement.children[0]
      .componentInstance as FederationTrustAnchorSelectComponent;
    await vi.waitFor(() => expect(select.unregistered).toBe(true));

    loaded.next([anchor]);

    expect(select.unregistered).toBe(false);
  });

  it('follows the disabled state of the bound control and hides its actions', async () => {
    const { fixture, select, element } = await render(
      'https://ta.example',
      vi.fn().mockResolvedValue([anchor])
    );

    fixture.componentInstance.control.disable();
    fixture.detectChanges();
    expect(select.selection.disabled).toBe(true);
    expect(element.querySelector('mat-select')?.getAttribute('aria-disabled')).toBe('true');
    expect(element.querySelector('a[target="_blank"]')).toBeNull();

    fixture.componentInstance.control.enable();
    fixture.detectChanges();
    expect(select.selection.disabled).toBe(false);
    expect(element.querySelector('a[target="_blank"]')).not.toBeNull();
  });

  it('shows the required error of the bound control once touched', async () => {
    const { fixture, element } = await render('', vi.fn().mockResolvedValue([anchor]));

    fixture.componentInstance.control.markAsTouched();
    fixture.detectChanges();

    expect(element.querySelector('mat-error')?.textContent).toContain('Choose a trust anchor');
  });
});
