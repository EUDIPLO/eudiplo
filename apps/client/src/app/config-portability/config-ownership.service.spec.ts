import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import type { ApiService } from '../core';
import type { JwtService, Role } from '../services/jwt.service';
import { effectiveRoles } from '../services/role-grants';
import { ConfigOwnershipService } from './config-ownership.service';

describe('ConfigOwnershipService', () => {
  let requests: string[];
  let status: number;
  let service: ConfigOwnershipService;
  let roles: string[];

  beforeEach(() => {
    requests = [];
    status = 200;
    client.setConfig({
      baseUrl: 'http://localhost:3000',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url.pathname);
        const kind = url.pathname.split('/').pop();
        const body =
          status !== 200
            ? { statusCode: status, message: 'Forbidden' }
            : kind === 'CredentialConfig'
              ? [{ kind, resourceId: 'pid', ownership: 'unmanaged', generation: 4 }]
              : [
                  {
                    kind: 'PresentationConfig',
                    resourceId: 'pid',
                    ownership: 'file-managed',
                    generation: 1,
                    source: 'folder:/config/demo',
                  },
                  {
                    kind: 'PresentationConfig',
                    resourceId: 'manual',
                    ownership: 'unmanaged',
                    generation: 2,
                  },
                ];
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    roles = ['tenant:admin'];
    service = new ConfigOwnershipService(
      { client } as ApiService,
      {
        hasRole: (role: Role | Role[]) =>
          [role].flat().some((r) => effectiveRoles(roles).includes(r)),
      } as JwtService
    );
  });

  // The backend refuses readers with 403, which the Web Client would take for lost roles.
  it('does not ask without a role that changes the kind', async () => {
    roles = ['presentation:read', 'issuance:manage'];

    expect(await service.get('PresentationConfig', 'pid')).toBeUndefined();
    expect(await service.get('CredentialConfig', 'pid')).toMatchObject({ ownership: 'unmanaged' });
    expect(requests).toEqual(['/api/config-bundles/resources/CredentialConfig']);
  });

  it('reads one kind with a single request for the lookups of a screen', async () => {
    const [notice, edit, other] = await Promise.all([
      service.get('PresentationConfig', 'pid'),
      service.get('PresentationConfig', 'pid'),
      service.get('PresentationConfig', 'manual'),
    ]);

    expect(notice).toMatchObject({ ownership: 'file-managed', source: 'folder:/config/demo' });
    expect(edit).toEqual(notice);
    expect(other).toMatchObject({ ownership: 'unmanaged' });
    expect(requests).toEqual(['/api/config-bundles/resources/PresentationConfig']);
  });

  it('keeps kinds apart when they share a resource ID', async () => {
    const [presentation, credential] = await Promise.all([
      service.get('PresentationConfig', 'pid'),
      service.get('CredentialConfig', 'pid'),
    ]);

    expect(presentation?.ownership).toBe('file-managed');
    expect(credential?.ownership).toBe('unmanaged');
    expect(requests.sort()).toEqual([
      '/api/config-bundles/resources/CredentialConfig',
      '/api/config-bundles/resources/PresentationConfig',
    ]);
  });

  it('asks again for a later screen', async () => {
    await service.get('PresentationConfig', 'pid');
    await service.get('PresentationConfig', 'pid');

    expect(requests).toHaveLength(2);
  });

  it('rejects a failed lookup and retries on the next one', async () => {
    status = 403;
    await expect(service.get('PresentationConfig', 'pid')).rejects.toMatchObject({
      statusCode: 403,
    });

    status = 200;
    await expect(service.get('PresentationConfig', 'pid')).resolves.toMatchObject({
      ownership: 'file-managed',
    });
    expect(requests).toHaveLength(2);
  });
});
