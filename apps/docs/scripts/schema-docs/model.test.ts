import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { buildSchemaModel } from "./model.js";

test("presentation request docs follow DTO metadata and preserve nested body shape", () => {
    const model = buildSchemaModel(PresentationRequestSchema);
    assert.equal(model.properties?.response_type.description, "Response mode for the presentation request.");
    assert.deepEqual(model.properties?.response_type.enum, ["uri", "dc-api", "iso-18013-7"]);
    assert.equal(model.properties?.response_type.required, true);
    assert.equal(model.properties?.webhook.required, false);
    assert.equal(model.properties?.webhook.properties?.url.required, true);
    assert.equal(model.properties?.webhook.properties?.auth.variants?.length, 2);
    assert.equal(model.properties?.transaction_data.items?.properties?.credential_ids.type, "array");
    assert.equal(model.properties?.skewSeconds.minimum, 0);
    assert.equal(model.properties?.transaction_data.items?.properties?.payload.type, "unknown");
});

test("changing schema metadata changes the generated description", () => {
    const changed = PresentationRequestSchema.extend({
        requestId: z.string().describe("Updated by the DTO schema."),
    });
    assert.equal(
        buildSchemaModel(changed).properties?.requestId.description,
        "Updated by the DTO schema.",
    );
});

test("unions of one scalar type, e.g. a value or a ${ENV} placeholder, render as that type", () => {
    const model = buildSchemaModel(
        z.object({
            url: z.union([z.string().url(), z.string().regex(/^\$\{[A-Z_]+\}$/)]).describe("Service URL."),
            mode: z.union([z.literal("a"), z.literal("b")]),
        }),
    );
    assert.equal(model.properties?.url.type, "string");
    assert.equal(model.properties?.url.variants, undefined);
    assert.equal(model.properties?.url.description, "Service URL.");
    assert.deepEqual(model.properties?.mode.enum, ["a", "b"]);
});

test("extracted webhook schema keeps both auth branches and strict validation", () => {
    const base = { requestId: "config", response_type: "uri" };
    assert.equal(PresentationRequestSchema.safeParse({
        ...base, webhook: { url: "https://example.com", auth: { type: "none" } },
    }).success, true);
    assert.equal(PresentationRequestSchema.safeParse({
        ...base,
        webhook: {
            url: "https://example.com",
            auth: { type: "apiKey", config: { headerName: "X-Key", value: "secret" } },
        },
    }).success, true);
    assert.equal(PresentationRequestSchema.safeParse({
        ...base, webhook: { url: "https://example.com", auth: { type: "none", extra: true } },
    }).success, false);
    // The DTO's existing schema accepted empty strings; the separate webhook config
    // schema has stronger min(1) rules and must not silently replace it here.
    assert.equal(PresentationRequestSchema.safeParse({
        ...base, webhook: { url: "", auth: { type: "apiKey", config: { headerName: "", value: "" } } },
    }).success, true);
});
