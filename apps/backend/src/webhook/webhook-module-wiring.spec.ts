import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";
import { AttributeProviderModule } from "../issuer/configuration/attribute-provider/attribute-provider.module.js";
import { WEBHOOK_ENDPOINT_REPOSITORY } from "../issuer/configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { WebhookEndpointModule } from "../issuer/configuration/webhook-endpoint/webhook-endpoint.module.js";
import { SchemaMetadataModule } from "../registrar/schema-metadata/schema-metadata.module.js";
import { OutboundUrlPolicyModule } from "./outbound-url-policy.module.js";
import { WebhookModule } from "./webhook.module.js";

const imports = (module: object): unknown[] =>
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? [];
const exportsOf = (module: object): unknown[] =>
    Reflect.getMetadata(MODULE_METADATA.EXPORTS, module) ?? [];
const provides = (module: object, token: unknown): boolean =>
    (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? []).some(
        (provider: { provide?: unknown }) => provider?.provide === token,
    );

describe("WebhookModule wiring", () => {
    it("uses the webhook endpoint repository of its owning module", () => {
        expect(
            provides(WebhookEndpointModule, WEBHOOK_ENDPOINT_REPOSITORY),
        ).toBe(true);
        expect(exportsOf(WebhookEndpointModule)).toContain(
            WEBHOOK_ENDPOINT_REPOSITORY,
        );
        expect(provides(WebhookModule, WEBHOOK_ENDPOINT_REPOSITORY)).toBe(
            false,
        );
        expect(imports(WebhookModule)).toContain(WebhookEndpointModule);
    });

    // Importing WebhookModule for the policy alone created the module cycle
    // that led to the duplicate provider.
    it.each([
        ["WebhookEndpointModule", WebhookEndpointModule],
        ["AttributeProviderModule", AttributeProviderModule],
        ["SchemaMetadataModule", SchemaMetadataModule],
    ])(
        "lets %s use the outbound URL policy without the webhook delivery",
        (_, module) => {
            expect(imports(module)).toContain(OutboundUrlPolicyModule);
            expect(imports(module)).not.toContain(WebhookModule);
        },
    );
});
