import { readFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import MCR from 'monocart-coverage-reports';
import ts from 'typescript';
import { resolvedE2EConfig } from './e2e-config';

// E2E_COVERAGE=true records Chromium's V8 coverage of every page (see
// support/test.ts) and maps it back to src/ through the build's source maps.
export const coverageEnabled = process.env['E2E_COVERAGE'] === 'true';

const clientOrigin = new URL(resolvedE2EConfig.baseURL).origin;
const distDir = resolve(process.cwd(), 'dist/apps/client/browser');

function clientBundlePath(url: string): string | undefined {
  try {
    const { origin, pathname } = new URL(url);
    return origin === clientOrigin ? pathname : undefined;
  } catch {
    return undefined;
  }
}

// The client's TypeScript without tests, declarations and the development environment that
// the production build replaces. Templates are left out: only the ones a test
// loads would show up.
function isClientSource(sourcePath: string): boolean {
  return (
    /^src\/.+\.ts$/.test(sourcePath) &&
    !sourcePath.endsWith('.spec.ts') &&
    !sourcePath.endsWith('.d.ts') &&
    sourcePath !== 'src/test-setup.ts' &&
    sourcePath !== 'src/environments/environment.ts'
  );
}

export const coverageOptions: MCR.CoverageReportOptions = {
  name: 'EUDIPLO client E2E coverage',
  outputDir: 'coverage/e2e',
  reports: ['v8', 'lcovonly', 'cobertura', 'console-summary'],
  // Flat packages in the Cobertura report, like the backend's.
  defaultSummarizer: 'pkg',
  // The app's own bundles at the root, not env.js or Monaco under assets/.
  entryFilter: (entry) => {
    const pathname = clientBundlePath(entry.url);
    return !!pathname && /^\/[^/]+\.js$/.test(pathname) && pathname !== '/env.js';
  },
  sourceFilter: isClientSource,
  // Report files no test loaded with 0% instead of leaving them out.
  all: {
    dir: ['./src'],
    // Called with absolute paths, unlike sourceFilter.
    filter: (filePath) => isClientSource(relative(process.cwd(), filePath).split(sep).join('/')),
    transformer: async (entry) => {
      const { outputText, sourceMapText } = ts.transpileModule(entry.source, {
        fileName: basename(entry.url),
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
          inlineSources: true,
        },
      });
      entry.source = outputText;
      // transpileModule names only the file; keep its path so it maps to src/...
      entry.sourceMap = { ...JSON.parse(sourceMapText!), sources: [entry.url] };
    },
  },
  // Read the maps from the build instead of over HTTP; the client server may be stopped by then.
  sourceMapResolver: async (url, defaultResolver) => {
    const pathname = clientBundlePath(url);
    if (pathname) {
      return JSON.parse(readFileSync(resolve(distDir, `.${pathname}`), 'utf8'));
    }
    return defaultResolver(url);
  },
};
