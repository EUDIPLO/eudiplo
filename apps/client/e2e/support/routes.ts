import type { Page } from '@playwright/test';

/**
 * Holds back `method` requests to a URL that ends with `path` until `release` is called, so
 * a spec can look at the page while a request runs. `sent` resolves when the first one has
 * left the page.
 */
export async function holdRequests(
  page: Page,
  method: string,
  path: string
): Promise<{ sent: Promise<void>; release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let markSent!: () => void;
  const sent = new Promise<void>((resolve) => (markSent = resolve));
  await page.route(
    (url) => url.pathname.endsWith(path),
    async (route) => {
      if (route.request().method() !== method) {
        await route.fallback();
        return;
      }
      markSent();
      await released;
      await route.fallback();
    }
  );
  return { sent, release };
}
