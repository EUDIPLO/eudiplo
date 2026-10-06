import { test as base } from '@playwright/test';
import MCR from 'monocart-coverage-reports';
import { coverageEnabled, coverageOptions } from './coverage';

export { expect } from '@playwright/test';

// Specs import `test` from here so that every page's JS coverage is recorded
// when E2E_COVERAGE=true. The report is written in coverage-global-setup.ts.
export const test = base.extend<{ jsCoverage: void }>({
  jsCoverage: [
    async ({ page }, use) => {
      if (!coverageEnabled) {
        await use();
        return;
      }
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      await MCR(coverageOptions).add(await page.coverage.stopJSCoverage());
    },
    { auto: true },
  ],
});
