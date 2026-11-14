#!/usr/bin/env node
// Checks that every published schema snapshot (schemas/v*/) has its canonical
// eudiplo.dev $id and that every cross-schema $ref points at a published
// snapshot. eudiplo.dev serves these files from EUDIPLO/website, whose
// scripts/build.mjs repeats these checks; change both together.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
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
    schemas.set(schema.$id, schema);
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
for (const [url, schema] of schemas) checkRefs(schema, url);
console.log(`${schemas.size} published schema files have canonical ids and references.`);
