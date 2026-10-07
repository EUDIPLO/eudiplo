import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { buildSchemaModel } from "./model.js";
import { renderSchemaBody, schemaTableRows } from "./render.js";

test("renders nested array objects with aligned indentation and parseable JSONC", () => {
    const output = renderSchemaBody(buildSchemaModel(PresentationRequestSchema));
    const parsed = JSON.parse(output.replace(/^\s*\/\/.*$/gm, ""));
    assert.equal(parsed.transaction_data[0].credential_ids[0], "string");
    assert.equal(parsed.webhook.auth.type, "apiKey");
    assert.match(output, /"transaction_data": \[\n\s+\{\n/);
    assert.match(output, /"credential_ids": \[\n\s+"string"\n\s+\]/);
    assert.match(output, /\n        \}\n    \]/);
    assert.doesNotMatch(output, /"payload": null/);
});

test("renders one full union object and readable alternative objects", () => {
    const output = renderSchemaBody(buildSchemaModel(PresentationRequestSchema));
    assert.match(output, /"auth": \{\n\s+\/\/ required; string; allowed: apiKey/);
    assert.match(output, /"config": \{\n/);
    const alternative = output.match(/\/\/ Alternative for auth: (\{[^\n]*\})/);
    assert.ok(alternative);
    assert.deepEqual(JSON.parse(alternative[1]), { type: "none" });
});

test("free-form values use a safe example rather than null or instructions", () => {
    const output = renderSchemaBody(buildSchemaModel(PresentationRequestSchema));
    assert.match(output, /"payload": \{\}/);
    assert.doesNotMatch(output, /replace this|insert here|null/);
});

test("table mode lists every top-level field with required flag, type and description", () => {
    const rows = schemaTableRows(buildSchemaModel(PresentationRequestSchema));
    const topLevel = rows.filter((row) => row.depth === 0).map((row) => row.path);
    assert.deepEqual(topLevel, Object.keys(PresentationRequestSchema.shape));
    const responseType = rows.find((row) => row.path === "response_type");
    assert.deepEqual(responseType, {
        path: "response_type",
        depth: 0,
        required: true,
        type: "string",
        allowed: ["uri", "dc-api", "iso-18013-7"],
        description: "Response mode for the presentation request.",
    });
    assert.equal(rows.find((row) => row.path === "webhook")?.required, false);
    assert.equal(rows.find((row) => row.path === "skewSeconds")?.minimum, 0);
});

test("table mode flattens nested objects and array items into dotted paths", () => {
    const rows = schemaTableRows(buildSchemaModel(PresentationRequestSchema));
    const webhookUrl = rows.find((row) => row.path === "webhook.url");
    assert.equal(webhookUrl?.depth, 1);
    assert.equal(webhookUrl?.required, true);
    assert.equal(rows.find((row) => row.path === "transaction_data")?.type, "array of object");
    const credentialIds = rows.find((row) => row.path === "transaction_data[].credential_ids");
    assert.equal(credentialIds?.depth, 1);
    assert.equal(credentialIds?.type, "array of string");
    assert.equal(rows.find((row) => row.path === "transaction_data[].payload")?.type, "any");
    // Every row's parent path is listed before it.
    rows.forEach((row, index) => {
        const parent = row.path.replace(/(\[\])?\.[^.]+$/, "");
        if (parent !== row.path) {
            assert.ok(rows.slice(0, index).some((other) => other.path === parent), `${row.path} without parent`);
        }
    });
});

test("table mode labels the fields of each union shape by its discriminator", () => {
    const rows = schemaTableRows(buildSchemaModel(PresentationRequestSchema));
    assert.equal(rows.find((row) => row.path === "webhook.auth")?.type, "one of 2 shapes");
    const authTypes = rows.filter((row) => row.path === "webhook.auth.type");
    assert.deepEqual(
        authTypes.map((row) => [row.variant, row.allowed]),
        [["when `type` is `apiKey`", ["apiKey"]], ["when `type` is `none`", ["none"]]],
    );
    assert.equal(
        rows.find((row) => row.path === "webhook.auth.config.headerName")?.variant,
        "when `type` is `apiKey`",
    );
});

test("table mode lists the fields that every union shape shares once", () => {
    const schema = z.object({
        query: z.discriminatedUnion("format", [
            z.object({ format: z.literal("mso_mdoc"), id: z.string(), doctype: z.string() }),
            z.object({ format: z.literal("dc+sd-jwt"), id: z.string(), vct: z.string() }),
        ]),
    });
    const rows = schemaTableRows(buildSchemaModel(schema)).filter((row) => row.path.startsWith("query."));
    assert.deepEqual(
        rows.map((row) => [row.path, row.variant]),
        [
            ["query.id", undefined],
            ["query.format", "when `format` is `mso_mdoc`"],
            ["query.doctype", "when `format` is `mso_mdoc`"],
            ["query.format", "when `format` is `dc+sd-jwt`"],
            ["query.vct", "when `format` is `dc+sd-jwt`"],
        ],
    );
});

test("table mode numbers the shapes of a union without a discriminator", () => {
    const schema = z.object({ value: z.union([z.object({ a: z.string() }), z.object({ b: z.number(), c: z.boolean() })]) });
    const rows = schemaTableRows(buildSchemaModel(schema)).filter((row) => row.path.startsWith("value."));
    assert.deepEqual(
        rows.map((row) => [row.path, row.variant]),
        [
            ["value.b", "in shape 1 of 2"],
            ["value.c", "in shape 1 of 2"],
            ["value.a", "in shape 2 of 2"],
        ],
    );
});

test("table mode lists the allowed values of enum arrays", () => {
    const schema = z.object({ formats: z.array(z.enum(["dc+sd-jwt", "mso_mdoc"])).describe("Accepted formats.") });
    const [row] = schemaTableRows(buildSchemaModel(schema));
    assert.deepEqual(row, {
        path: "formats",
        depth: 0,
        required: true,
        type: "array of string",
        allowed: ["dc+sd-jwt", "mso_mdoc"],
        description: "Accepted formats.",
    });
});
