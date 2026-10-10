import { TestBed } from '@angular/core/testing';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { JwtService } from '../../services/jwt.service';
import { PresentationManagementService } from './presentation-management.service';

describe('PresentationManagementService', () => {
  let roles: string[];
  let responses: Record<string, unknown>;
  let requests: string[];
  let service: PresentationManagementService;

  beforeEach(() => {
    roles = [];
    responses = { '/api/verifier/config/pid': { id: 'pid' } };
    requests = [];
    client.setConfig({
      baseUrl: 'http://localhost:3000',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url.pathname);
        const body = responses[url.pathname];
        return new Response(JSON.stringify(body ?? {}), {
          status: body === undefined ? 403 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
          },
        },
      ],
    });
    service = TestBed.inject(PresentationManagementService);
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('leaves the access certificate check to the backend for users who cannot read key chains', async () => {
    roles = ['presentation:request'];

    await expect(service.checkPresentationReadiness('pid')).resolves.toEqual({ ready: true });
    expect(requests).not.toContain('/api/key-chain');
  });

  it('requires an access certificate for users who can read key chains', async () => {
    roles = ['presentation:request', 'presentation:manage'];
    responses['/api/key-chain'] = [];

    await expect(service.checkPresentationReadiness('pid')).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining('No access key chain'),
    });
  });
});
