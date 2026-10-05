// Starts the built backend (apps/backend/dist) for E2E_USE_BUILD runs.
// Every run gets a fresh SQLite database and imports the demo tenant from
// assets/config/demo plus the test fixtures below. The working directory is
// the throwaway folder, so apps/backend/.env is not loaded.
//
// Imported resources are file-managed and read-only in the client, so tests
// that change data create their own resources.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const backendMain = resolve(repoRoot, 'apps/backend/dist/main.js');
const workDir = resolve(repoRoot, 'apps/client/tmp/e2e-backend');

if (!existsSync(backendMain)) {
  console.error(`${backendMain} is missing; run pnpm --filter @eudiplo/backend build first.`);
  process.exit(1);
}

rmSync(workDir, { recursive: true, force: true });
cpSync(resolve(repoRoot, 'assets/config/demo'), resolve(workDir, 'config/demo'), {
  recursive: true,
});
mkdirSync(resolve(workDir, 'data'), { recursive: true });

const apiUrl = new URL(process.env['PLAYWRIGHT_API_URL'] ?? 'http://127.0.0.1:3000');

// Authorization code offers need an authorization server other than the
// built-in one, and offer creation fetches its metadata. The backend's own
// management OAuth server (/.well-known/oauth-authorization-server) stands in.
const issuanceFile = resolve(workDir, 'config/demo/issuance/issuance.json');
const issuance = JSON.parse(readFileSync(issuanceFile, 'utf8'));
issuance.spec.authorizationServers.push({
  id: 'e2e-external',
  type: 'external',
  issuer: apiUrl.origin,
  label: 'E2E external AS',
});
writeFileSync(issuanceFile, JSON.stringify(issuance, null, 2));

process.chdir(workDir);

Object.assign(process.env, {
  FOLDER: resolve(workDir, 'data'),
  CONFIG_FOLDER: resolve(workDir, 'config'),
  CONFIG_IMPORT_MODE: 'create',
  PORT: apiUrl.port || '3000',
  PUBLIC_URL: apiUrl.origin,
  MASTER_SECRET: process.env['MASTER_SECRET'] ?? 'e2e-master-secret-with-at-least-32-chars',
  AUTH_CLIENT_ID: process.env['AUTH_CLIENT_ID'] ?? 'root',
  AUTH_CLIENT_SECRET: process.env['AUTH_CLIENT_SECRET'] ?? 'root',
  // The demo tenant points its attribute provider and webhook at http://localhost.
  OUTBOUND_URL_ALLOW_HTTP: 'true',
  OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: 'true',
});

await import(pathToFileURL(backendMain).href);
