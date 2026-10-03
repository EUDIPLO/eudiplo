import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSchemaModel } from "./model.js";
import { schemaDocs } from "./registry.js";

test("registry names are unique file-safe identifiers and every schema builds an object model", () => {
    const names = schemaDocs.map((entry) => entry.name);
    assert.deepEqual(names, [...new Set(names)]);
    for (const { name, schema } of schemaDocs) {
        assert.match(name, /^[a-z0-9-]+$/);
        const model = buildSchemaModel(schema);
        assert.ok(model.properties ?? model.variants, `${name} has no fields`);
    }
    assert.ok(names.includes("presentation-request"));
});
