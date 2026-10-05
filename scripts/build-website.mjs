#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const website = resolve(root, "apps/website");
const output = resolve(website, "dist");
const schemas = new Map();
for (const version of readdirSync(resolve(root, "schemas"))
  .filter((name) => /^v[1-9][0-9]*$/.test(name))
  .sort()) {
  for (const file of readdirSync(resolve(root, "schemas", version))
    .filter((name) => name.endsWith(".schema.json"))
    .sort()) {
    const path = `${version}/${file}`;
    const schema = JSON.parse(
      readFileSync(resolve(root, "schemas", path), "utf8"),
    );
    if (schema.$id !== `https://eudiplo.dev/schemas/${path}`)
      throw new Error(`Noncanonical schema $id: ${path}`);
    schemas.set(schema.$id, { path, schema });
  }
}
if (!schemas.size) throw new Error("No published schema snapshots");
function checkRefs(value, base) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
    const url = new URL(value.$ref, base);
    url.hash = "";
    if (!schemas.has(url.href))
      throw new Error(`Unbundled schema reference: ${url.href}`);
  }
  Object.values(value).forEach((item) => checkRefs(item, base));
}
for (const [url, { schema }] of schemas) checkRefs(schema, url);
// Stage only deployable assets; repository/package files are never published.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of [
  "index.html",
  "install.sh",
  "logo.svg",
  "eudiplo.png",
  "mark.png",
  "favicon-32.png",
  "icon-192.png",
  "apple-touch-icon.png",
  "fonts",
  "_headers",
  "404.html",
]) {
  if (!existsSync(resolve(website, file)))
    throw new Error(`Missing website asset: ${file}`);
  cpSync(resolve(website, file), resolve(output, file), { recursive: true });
}
for (const { path } of schemas.values()) {
  const target = resolve(output, "schemas", path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  cpSync(resolve(root, "schemas", path), target);
}
const catalog = [...schemas]
  .filter(([, { schema }]) => schema.properties?.$schema)
  .map(([url, { schema }]) => ({ name: schema.title, url }));
writeFileSync(
  resolve(output, "schemas/index.json"),
  `${JSON.stringify({ schemas: catalog }, null, 2)}\n`,
);
console.log(
  `Website staged in apps/website/dist with ${schemas.size} schema files (${catalog.length} config formats).`,
);
