import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '@eudiplo/sdk-core';
import { KeyChainService } from './key-chain.service';

describe('KeyChainService.createCsr', () => {
  const fetchMock = vi.fn<typeof fetch>();

  /** The URLs the SDK requested. */
  const requested = () =>
    fetchMock.mock.calls.map(([input]) => new URL((input as Request).url ?? String(input)));

  beforeEach(() => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ csr: 'CSR' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    client.setConfig({ baseUrl: 'http://localhost', fetch: fetchMock });
  });

  afterEach(() => {
    fetchMock.mockReset();
    client.setConfig({ fetch: globalThis.fetch });
  });

  it('leaves out an empty subject, so the backend uses its default', async () => {
    await expect(new KeyChainService().createCsr('k', '')).resolves.toBe('CSR');

    const [url] = requested();
    expect(url.pathname).toBe('/api/key-chain/k/csr');
    expect(url.searchParams.has('subject')).toBe(false);
  });

  it('sends the subject', async () => {
    await new KeyChainService().createCsr('k', 'CN=a');

    expect(requested()[0].searchParams.get('subject')).toBe('CN=a');
  });
});
