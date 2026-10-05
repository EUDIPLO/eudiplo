// Serves the production build (dist/apps/client/browser) for E2E_USE_BUILD
// runs the way the client Docker image does (nginx.conf, docker-entrypoint.sh):
// static files, index.html for app routes, and a generated env.js that points
// the client at the E2E backend.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/apps/client/browser');
const indexHtml = resolve(root, 'index.html');
const baseUrl = new URL(process.env['PLAYWRIGHT_TEST_BASE_URL'] ?? 'http://127.0.0.1:4200');
const apiUrl = process.env['PLAYWRIGHT_API_URL'] ?? 'http://127.0.0.1:3000';

if (!existsSync(indexHtml)) {
  console.error(`${indexHtml} is missing; run pnpm --filter @eudiplo/client build first.`);
  process.exit(1);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
};
// Like nginx.conf: missing static assets are a 404, every other path is an app route.
const staticAsset = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i;

const envJs = `(function (window) {
  window['env'] = window['env'] || {};
  window['env']['apiUrl'] = ${JSON.stringify(apiUrl)};
  window['env']['baseHref'] = '/';
})(this);
`;

function resolveFile(pathname) {
  let file;
  try {
    file = resolve(root, `.${decodeURIComponent(pathname)}`);
  } catch {
    return undefined;
  }
  if (file !== root && !file.startsWith(root + sep)) {
    return undefined;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    return file;
  }
  return staticAsset.test(pathname) ? undefined : indexHtml;
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', baseUrl);
  if (pathname === '/env.js') {
    res.writeHead(200, { 'content-type': contentTypes['.js'], 'cache-control': 'no-store' });
    res.end(envJs);
    return;
  }

  const file = resolveFile(pathname);
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
}).listen(Number(baseUrl.port || 80), baseUrl.hostname, () => {
  console.log(`Serving ${root} on ${baseUrl.origin} (API ${apiUrl})`);
});
