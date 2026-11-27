import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeListStates } from '../../common/base-async-list.testing';
import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { FederationTrustAnchorService } from '../federation-trust-anchor.service';
import { FederationTrustAnchorListComponent } from './federation-trust-anchor-list.component';
import { grantEveryRole } from '../../common/role-lock.testing';

// The tests are about what the actions do; role locks have their own tests.
beforeEach(() => grantEveryRole());

describe('FederationTrustAnchorListComponent', () => {
  const anchor = {
    id: 'eu-federation',
    tenantId: 'tenant',
    entityId: 'https://ta.example',
    description: 'EU federation',
    jwks: {
      keys: [
        { kty: 'EC', kid: 'a' },
        { kty: 'EC', kid: 'b' },
      ],
    },
  };

  async function render() {
    TestBed.configureTestingModule({
      imports: [FederationTrustAnchorListComponent],
      providers: [
        provideRouter([]),
        { provide: FederationTrustAnchorService, useValue: { getAll: async () => [anchor] } },
        { provide: ConfigDocumentService, useValue: { isDownloading: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(FederationTrustAnchorListComponent);
    const loadItems = vi.spyOn(fixture.componentInstance, 'loadItems');
    fixture.detectChanges();
    await loadItems.mock.results[0].value;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the entity ID and the number of pinned keys of each trust anchor', async () => {
    const element = await render();

    const cells = [...element.querySelectorAll('tr[mat-row] td')].map((td) =>
      td.textContent?.trim()
    );
    expect(cells.slice(0, 4)).toEqual([
      'eu-federation',
      'https://ta.example',
      'EU federation',
      '2',
    ]);
    const actions = [...element.querySelectorAll('tr[mat-row] .row-actions a, tr[mat-row] button')];
    expect(actions.map((b) => b.getAttribute('aria-label'))).toEqual([
      'View trust anchor eu-federation',
      'Edit trust anchor eu-federation',
      'Download the configuration of trust anchor eu-federation',
    ]);
    // View and Edit are links, so they open in a new tab too.
    expect(actions.map((action) => action.tagName)).toEqual(['A', 'A', 'BUTTON']);
  });
});

describeListStates({
  component: FederationTrustAnchorListComponent,
  service: FederationTrustAnchorService,
  fetchMethod: 'getAll',
  item: { id: 'eu-federation', entityId: 'https://ta.example', jwks: { keys: [] } },
  loading: 'Loading federation trust anchors',
  empty: 'No federation trust anchors yet.',
  create: 'Register trust anchor',
  createButton: 'Register a trust anchor',
  failure: 'Failed to load federation trust anchors',
});
