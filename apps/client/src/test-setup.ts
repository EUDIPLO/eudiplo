import { client } from '@eudiplo/sdk-core';

/**
 * Global Vitest setup for the client unit tests.
 *
 * Node.js 25+ ships its own `localStorage`/`sessionStorage` globals, which shadow
 * the jsdom implementations and are `undefined` unless `--localstorage-file` is
 * passed. jsdom also does not implement `window.matchMedia`. Provide in-memory
 * fallbacks so components and services that touch these APIs can be created.
 */

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (!globalThis[name]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: createMemoryStorage(),
    });
  }
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

/**
 * Unit tests must never reach the network. Components call the SDK from
 * `ngOnInit`, and without a backend those requests reject (or fail to build a
 * `Request` from a relative URL) after the test has finished, surfacing as
 * unhandled errors in unrelated spec files. Give the SDK client an absolute base
 * URL and a `fetch` that never settles; specs that need responses mock the
 * service layer or pass their own `fetch` via `client.setConfig`.
 */
const pendingFetch = (): Promise<Response> => new Promise<Response>(() => undefined);
globalThis.fetch = pendingFetch;
client.setConfig({ baseUrl: 'http://localhost', fetch: pendingFetch });
