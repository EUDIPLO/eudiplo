import assert from "node:assert/strict";
import { test } from "node:test";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { buildRequestBodyModel } from "./model.js";
import { renderRequestBody } from "./render.js";

test("renders nested array objects with aligned indentation and parseable JSONC", () => {
    const output = renderRequestBody(buildRequestBodyModel(PresentationRequestSchema));
    const parsed = JSON.parse(output.replace(/^\s*\/\/.*$/gm, ""));
    assert.equal(parsed.transaction_data[0].credential_ids[0], "string");
    assert.equal(parsed.webhook.auth.type, "apiKey");
    assert.match(output, /"transaction_data": \[\n\s+\{\n/);
    assert.match(output, /"credential_ids": \[\n\s+"string"\n\s+\]/);
    assert.match(output, /\n        \}\n    \]/);
    assert.doesNotMatch(output, /"payload": null/);
});

test("renders one full union object and readable alternative objects", () => {
    const output = renderRequestBody(buildRequestBodyModel(PresentationRequestSchema));
    assert.match(output, /"auth": \{\n\s+\/\/ required; string; allowed: apiKey/);
    assert.match(output, /"config": \{\n/);
    const alternative = output.match(/\/\/ Alternative for auth: (\{[^\n]*\})/);
    assert.ok(alternative);
    assert.deepEqual(JSON.parse(alternative[1]), { type: "none" });
});

test("free-form values use a safe example rather than null or instructions", () => {
    const output = renderRequestBody(buildRequestBodyModel(PresentationRequestSchema));
    assert.match(output, /"payload": \{\}/);
    assert.doesNotMatch(output, /replace this|insert here|null/);
});
