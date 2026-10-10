import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";

describe("ConfigDocumentValidationService", () => {
    const migrations = new ConfigMigrationService(new ConfigResourceRegistry());
    const skipTrustAuthority = { value: false };
    const service = new ConfigDocumentValidationService(migrations, {
        get: (key: string) =>
            key === "SKIP_TRUST_AUTHORITY"
                ? skipTrustAuthority.value
                : undefined,
    } as any);

    it("accepts an explicit key-regeneration decision", () => {
        expect(
            service.validate({
                $schema: schemaUrl("KeyChain"),
                kind: "KeyChain",
                metadata: {},
                spec: {
                    id: "issuer",
                    usageType: "attestation",
                    kmsProvider: "db",
                    keySource: {
                        type: "regenerate",
                        keyChainType: "internalChain",
                    },
                },
            }),
        ).toEqual([]);
    });

    it("accepts identity carried by the schema-described spec", () => {
        expect(
            service.validate({
                $schema: schemaUrl("Client"),
                kind: "Client",
                metadata: {},
                spec: {
                    clientId: "different",
                    roles: ["clients:manage"],
                },
            }),
        ).toEqual([]);
    });

    describe("presentation configs", () => {
        const presentation = (trusted_authorities?: unknown[]) => ({
            $schema: schemaUrl("PresentationConfig"),
            kind: "PresentationConfig" as const,
            metadata: {},
            spec: {
                id: "pid",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:eudi:pid:1"] },
                            ...(trusted_authorities
                                ? { trusted_authorities }
                                : {}),
                        },
                    ],
                },
            },
        });

        afterEach(() => {
            skipTrustAuthority.value = false;
        });

        it("accepts credential queries with trusted_authorities", () => {
            expect(
                service.validate(
                    presentation([
                        {
                            type: "etsi_tl",
                            values: [{ trustListId: "pid-issuers" }],
                        },
                    ]),
                ),
            ).toEqual([]);
        });

        it("reports credential queries without trusted_authorities", () => {
            expect(service.validate(presentation())).toEqual([
                expect.objectContaining({
                    severity: "error",
                    code: "TRUSTED_AUTHORITY_REQUIRED",
                    path: "/spec/dcql_query/credentials",
                    message: expect.stringContaining(
                        "Credential queries without trusted_authorities: pid.",
                    ),
                    resource: { kind: "PresentationConfig", id: "pid" },
                }),
            ]);
        });

        it("accepts them with SKIP_TRUST_AUTHORITY", () => {
            skipTrustAuthority.value = true;
            expect(service.validate(presentation())).toEqual([]);
        });
    });
});
