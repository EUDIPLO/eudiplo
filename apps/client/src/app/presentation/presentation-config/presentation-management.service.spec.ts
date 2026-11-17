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

  describe("with the tenant's default access key chain", () => {
    const withCertificate = (id: string) => ({
      id,
      usageType: 'access',
      activeCertificate: { pem: '-----BEGIN CERTIFICATE-----' },
    });

    beforeEach(() => {
      roles = ['presentation:manage'];
    });

    it('is ready when the default has a certificate', async () => {
      responses['/api/key-chain'] = [withCertificate('chosen')];
      responses['/api/key-chain/access/default'] = {
        defaultAccessKeyChainId: 'chosen',
        keyChainId: 'chosen',
      };

      await expect(service.checkPresentationReadiness('pid')).resolves.toEqual({ ready: true });
    });

    it('is not ready when the default is gone, although another key chain has a certificate', async () => {
      responses['/api/key-chain'] = [withCertificate('other')];
      responses['/api/key-chain/access/default'] = { defaultAccessKeyChainId: 'gone' };

      await expect(service.checkPresentationReadiness('pid')).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining('default access key chain of the tenant does not exist'),
      });
    });

    it('is not ready when the default has no certificate', async () => {
      responses['/api/key-chain'] = [
        withCertificate('other'),
        { id: 'chosen', usageType: 'access' },
      ];
      responses['/api/key-chain/access/default'] = {
        defaultAccessKeyChainId: 'chosen',
        keyChainId: 'chosen',
      };

      await expect(service.checkPresentationReadiness('pid')).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining(
          'default access key chain has no active access certificate'
        ),
      });
    });
  });
});
