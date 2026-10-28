import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { buildSchemaModel, overrideDescriptions } from "./model.js";

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
    // Inline webhooks use the published WebhookConfig schema, which rejects
    // an empty URL, header name or API key.
    assert.equal(PresentationRequestSchema.safeParse({
        ...base, webhook: { url: "", auth: { type: "apiKey", config: { headerName: "", value: "" } } },
    }).success, false);
});

test("nullable fields keep their type and are marked nullable", () => {
    const model = buildSchemaModel(
        z.object({
            label: z.string().nullable().describe("A label."),
            nested: z.object({ value: z.string() }).nullable().optional(),
            list: z.array(z.string()).nullable(),
        }),
    );
    assert.equal(model.properties?.label.type, "string");
    assert.equal(model.properties?.label.nullable, true);
    assert.equal(model.properties?.label.description, "A label.");
    assert.equal(model.properties?.nested.type, "object");
    assert.equal(model.properties?.nested.nullable, true);
    assert.equal(model.properties?.nested.properties?.value.required, true);
    assert.equal(model.properties?.list.type, "array");
    assert.equal(model.properties?.list.variants, undefined);
});

test("description overrides replace the description and reject unknown paths", () => {
    const schema = z.object({ items: z.array(z.object({ url: z.string().describe("Base URL.") })) });
    const model = overrideDescriptions(buildSchemaModel(schema), { "items.url": "Posted to as is." });
    assert.equal(model.properties?.items.items?.properties?.url.description, "Posted to as is.");
    assert.throws(() => overrideDescriptions(buildSchemaModel(schema), { "items.uri": "x" }), /unknown field "items.uri"/);
});

test("description overrides reach fields of union variants", () => {
    const schema = z.object({
        entities: z.array(
            z.discriminatedUnion("type", [
                z.object({ type: z.literal("internal"), keyChainId: z.string() }),
                z.object({ type: z.literal("external"), certPem: z.string().describe("PEM.") }),
            ]),
        ),
    });
    const model = overrideDescriptions(buildSchemaModel(schema), { "entities.certPem": "PEM or Base64 DER." });
    const variants = model.properties?.entities.items?.variants ?? [];
    assert.equal(variants.find((variant) => variant.properties?.certPem)?.properties?.certPem.description, "PEM or Base64 DER.");
    assert.throws(() => overrideDescriptions(buildSchemaModel(schema), { "entities.cert": "x" }), /unknown field "entities.cert"/);
});

test("description overrides change a field in every variant that has it", () => {
    const schema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("a"), info: z.string().describe("A.") }),
        z.object({ type: z.literal("b"), info: z.string().describe("B.") }),
    ]);
    const model = overrideDescriptions(buildSchemaModel(schema), { info: "Shared." });
    assert.deepEqual(
        model.variants?.map((variant) => variant.properties?.info.description),
        ["Shared.", "Shared."],
    );
});

test("fields that reference a recursive or named schema show its type", () => {
    const node: z.ZodType = z.lazy(() => z.object({ children: z.array(node).optional() }));
    const named = z.object({ min: z.number().optional() }).meta({ id: "DocsNamedConstraints" });
    const model = buildSchemaModel(
        z.object({ tree: node, constraints: named.optional().describe("Rules.") }),
    );
    assert.equal(model.properties?.tree.type, "object");
    assert.equal(model.properties?.constraints.type, "object");
    assert.equal(model.properties?.constraints.description, "Rules.");
});

test("a referenced schema without its own description keeps the one of its definition", () => {
    const named = z.object({ min: z.number().optional() }).describe("Defined rules.").meta({ id: "DocsDescribedConstraints" });
    const model = buildSchemaModel(z.object({ constraints: named }));
    assert.equal(model.properties?.constraints.type, "object");
    assert.equal(model.properties?.constraints.description, "Defined rules.");
});
