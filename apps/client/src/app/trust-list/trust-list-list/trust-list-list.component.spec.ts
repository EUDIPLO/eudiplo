import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { TrustList } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeListStates } from '../../common/base-async-list.testing';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { TrustListService } from '../trust-list.service';
import { TrustListListComponent } from './trust-list-list.component';

describe('TrustListListComponent', () => {
  const trustList = {
    id: 'membership-issuers',
    description: 'Issuers of membership credentials',
  } as TrustList;

  async function render(
    service: Partial<TrustListService>,
    configDocuments: Partial<ConfigDocumentService> = { isDownloading: () => false }
  ) {
    TestBed.configureTestingModule({
      imports: [TrustListListComponent],
      providers: [
        provideRouter([]),
        { provide: TrustListService, useValue: service },
        { provide: ConfigDocumentService, useValue: configDocuments },
      ],
    });
    const fixture = TestBed.createComponent(TrustListListComponent);
    const loadItems = vi.spyOn(fixture.componentInstance, 'loadItems');
    fixture.detectChanges();
    await loadItems.mock.results[0].value;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the trust list in the label of each row action', async () => {
    const element = await render({ getAll: async () => [trustList] });

    const row = element.querySelector('tr[mat-row]') as HTMLElement;
    const actions = [...row.querySelectorAll('.row-actions a, .row-actions button')];
    expect(actions.map((b) => b.getAttribute('aria-label'))).toEqual([
      'View trust list membership-issuers',
      'Edit trust list membership-issuers',
      'Download the configuration of trust list membership-issuers',
    ]);
    // View and Edit are links, so they open in a new tab too.
    expect(actions.map((action) => action.tagName)).toEqual(['A', 'A', 'BUTTON']);
  });

  it('downloads the configuration of the clicked trust list', async () => {
    const downloadWithFeedback = vi.fn().mockResolvedValue(undefined);
    const element = await render(
      { getAll: async () => [trustList] },
      { downloadWithFeedback, isDownloading: () => false }
    );

    element
      .querySelector<HTMLButtonElement>('button[mattooltip="Download configuration"]')
      ?.click();

    expect(downloadWithFeedback).toHaveBeenCalledWith('TrustList', 'membership-issuers');
  });

  it('disables the download of a list while its document is being downloaded', async () => {
    const element = await render(
      { getAll: async () => [trustList] },
      { isDownloading: (kind, id) => kind === 'TrustList' && id === 'membership-issuers' }
    );

    expect(
      element
        .querySelector('button[mattooltip="Download configuration"]')
        ?.getAttribute('aria-disabled')
    ).toBe('true');
  });

  describeListStates({
    component: TrustListListComponent,
    service: TrustListService,
    fetchMethod: 'getAll',
    item: trustList,
    loading: 'Loading trust lists',
    empty: 'No trust lists yet.',
    create: 'Create Trust List',
    // The cookbook E2E test finds the button by this tooltip.
    createButton: 'Create new Trust List',
    failure: 'Failed to load trust lists',
  });
});
