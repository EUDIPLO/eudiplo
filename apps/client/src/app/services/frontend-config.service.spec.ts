import { TestBed } from '@angular/core/testing';
import { client } from '@eudiplo/sdk-core';
import { vi } from 'vitest';

import { ApiService } from '../core';
import { FrontendConfigService } from './frontend-config.service';

describe('FrontendConfigService', () => {
  let instanceUrl: string;
  let publicUrl: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    instanceUrl = 'http://localhost:3000';
    publicUrl = 'https://eudiplo.example.com';
    fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            grafana: { tempoUid: 'tempo', lokiUid: 'loki' },
            configImportMode: 'disabled',
            publicUrl,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    client.setConfig({ fetch: fetchMock });
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { getBaseUrl: () => instanceUrl } }],
    });
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('reports the public URL of the backend', async () => {
    const service = TestBed.inject(FrontendConfigService);

    expect(await service.getConfig()).toEqual({
      configImportMode: 'disabled',
      publicUrl: 'https://eudiplo.example.com',
    });
  });

  it('leaves the public URL out for backends that do not report it', async () => {
    publicUrl = undefined;
    const service = TestBed.inject(FrontendConfigService);

    expect((await service.getConfig())?.publicUrl).toBeUndefined();
  });

  it('loads the configuration again after signing in to another instance', async () => {
    const service = TestBed.inject(FrontendConfigService);
    await service.getConfig();
    await service.getConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    instanceUrl = 'https://admin.other.example';
    publicUrl = 'https://other.example';

    expect((await service.getConfig())?.publicUrl).toBe('https://other.example');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
