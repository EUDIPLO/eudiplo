import { TestBed } from '@angular/core/testing';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { ActivityLogService } from './activity-log.service';

describe('ActivityLogService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends several actions as a repeated parameter', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetch);
    client.setConfig({ baseUrl: 'http://backend.test', fetch });

    await TestBed.inject(ActivityLogService).search({
      page: 1,
      pageSize: 25,
      actionType: ['tenant_updated', 'oidc_client_deleted'],
    });

    const request = fetch.mock.calls[0][0] as Request;
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/admin/audit-logs/search');
    expect(url.searchParams.getAll('actionType')).toEqual([
      'tenant_updated',
      'oidc_client_deleted',
    ]);
  });
});
