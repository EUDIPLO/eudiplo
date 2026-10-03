import { describe, expect, it } from "vitest";
import { REMOVED_CHAINED_VP_MESSAGE } from "../domain/removed-authorization-servers.js";
import { IssuanceConfigSchema } from "./issuance.schema.js";

describe("IssuanceConfigSchema", () => {
    it("rejects the removed 'vp' option with a pointer to the oid4vp type", () => {
        const result = IssuanceConfigSchema.safeParse({
            authorizationServers: [
                {
                    type: "chained",
                    id: "legacy-vp",
                    upstream: {
                        issuer: "https://idp.example",
                        clientId: "eudiplo",
                    },
                    vp: { enabled: true, presentationConfigId: "pid" },
                },
            ],
        });

        expect(result.success).toBe(false);
        expect(result.error?.issues).toContainEqual(
            expect.objectContaining({
                code: "unrecognized_keys",
                message: REMOVED_CHAINED_VP_MESSAGE,
            }),
        );
    });

    it("keeps the generic message for other unknown keys", () => {
        const result = IssuanceConfigSchema.safeParse({
            authorizationServers: [
                {
                    type: "chained",
                    id: "chained",
                    upstream: {
                        issuer: "https://idp.example",
                        clientId: "eudiplo",
                    },
                    unknown: true,
                },
            ],
        });

        expect(result.error?.issues).toContainEqual(
            expect.objectContaining({ code: "unrecognized_keys" }),
        );
        expect(JSON.stringify(result.error?.issues)).not.toContain("oid4vp");
    });

    it.each([
        [{ role: "trust_anchor" }, ["federation", "role"]],
        [
            { enforceSigningPolicy: false },
            ["federation", "enforceSigningPolicy"],
        ],
    ])("rejects the unsupported federation option %o", (option, path) => {
        const result = IssuanceConfigSchema.safeParse({
            authorizationServers: [{ type: "built-in", id: "built-in" }],
            federation: {
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
                ...option,
            },
        });

        expect(result.success).toBe(false);
        expect(result.error?.issues).toContainEqual(
            expect.objectContaining({ code: "custom", path }),
        );
    });

    it("accepts the leaf role with an enforced signing policy", () => {
        const result = IssuanceConfigSchema.safeParse({
            authorizationServers: [{ type: "built-in", id: "built-in" }],
            federation: {
                role: "leaf",
                enforceSigningPolicy: true,
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
        });

        expect(result.error?.issues).toBeUndefined();
    });
});
