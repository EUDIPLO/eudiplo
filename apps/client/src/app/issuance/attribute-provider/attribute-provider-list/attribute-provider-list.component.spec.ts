import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AttributeProviderEntity } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeListStates } from '../../../common/base-async-list.testing';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { JwtService } from '../../../services/jwt.service';
import { AttributeProviderService } from '../attribute-provider.service';
import { AttributeProviderListComponent } from './attribute-provider-list.component';
import { grantEveryRole } from '../../../common/role-lock.testing';
import { effectiveRoles } from '../../../services/role-grants';

// The tests are about what the actions do; role locks have their own tests.
beforeEach(() => grantEveryRole());

describe('AttributeProviderListComponent', () => {
  describeListStates({
    component: AttributeProviderListComponent,
    service: AttributeProviderService,
    fetchMethod: 'getAll',
    item: { id: 'crm', name: 'CRM', url: 'https://crm.example', auth: { type: 'none' } },
    loading: 'Loading attribute providers',
    empty: 'No attribute providers yet.',
    create: 'Create attribute provider',
    failure: 'Failed to load attribute providers',
    heading: 'h1',
    firstCell: 'CRM',
  });
});

describe('AttributeProviderListComponent table', () => {
  const providers = [
    { id: 'registry', name: 'Registry', url: 'https://registry.example', auth: { type: 'none' } },
    { id: 'crm', name: 'CRM', url: 'https://crm.example', auth: { type: 'none' } },
  ] as AttributeProviderEntity[];

  async function render(service: Partial<AttributeProviderService>, roles = ['issuance:manage']) {
    TestBed.configureTestingModule({
      imports: [AttributeProviderListComponent],
      providers: [
        provideRouter([]),
        { provide: AttributeProviderService, useValue: service },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) =>
              [role].flat().some((r) => effectiveRoles(roles).includes(r)),
          },
        },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(AttributeProviderListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    fixture.detectChanges();
    return fixture;
  }

  const names = (element: HTMLElement) =>
    [...element.querySelectorAll('.item-link')].map((link) => link.textContent?.trim());

  afterEach(() => vi.restoreAllMocks());

  it('links a provider whose ID contains a slash as one segment', async () => {
    const fixture = await render({ getAll: async () => [{ ...providers[1], id: 'team/crm' }] });
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.item-link')?.getAttribute('href')).toBe('/team%2Fcrm');
  });

  it('sorts by name, links each name to its provider and narrows the rows to the search', async () => {
    const fixture = await render({ getAll: async () => providers });
    const element = fixture.nativeElement as HTMLElement;

    expect(names(element)).toEqual(['CRM', 'Registry']);
    expect(element.querySelector('.item-link')?.getAttribute('href')).toBe('/crm');
    expect(element.querySelector('output')?.textContent?.trim()).toBe('2 attribute providers');

    fixture.componentInstance.search = 'registry.example';
    fixture.detectChanges();
    expect(names(element)).toEqual(['Registry']);
    expect(element.querySelector('output')?.textContent?.trim()).toBe('1 of 2 attribute providers');

    fixture.componentInstance.search = 'nothing';
    fixture.detectChanges();
    expect(element.querySelector('.no-match')?.textContent).toContain(
      'No attribute provider matches "nothing".'
    );
  });

  it('deletes a provider from its row after confirming and takes its row out', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue(providers);
    const fixture = await render({ getAll, delete: remove });
    const element = fixture.nativeElement as HTMLElement;

    element
      .querySelector<HTMLButtonElement>('button[aria-label="Delete attribute provider crm"]')!
      .click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        [...element.querySelectorAll('.item-link')].map((a) => a.getAttribute('href'))
      ).not.toContain('/crm');
    });
    // The row goes without loading the list again.
    expect(getAll).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(
      'Delete attribute provider "CRM"? This cannot be undone.'
    );
    expect(remove).toHaveBeenCalledWith('crm');
  });
});
