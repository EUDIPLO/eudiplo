import { describe, expect, test } from "vitest";
import { CredentialConfigCreateSchema } from "./credential-config.schema.js";

const credentialConfig = {
    id: "pid",
    config: {
        format: "dc+sd-jwt",
        display: [],
    },
    fields: [],
};

describe("CredentialConfigCreateSchema active credential policy", () => {
    test("requires status management when the policy is enabled", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            statusManagement: false,
            activeCredentials: { enabled: true },
        });

        expect(result.success).toBe(false);
        expect(result.error?.issues).toEqual([
            expect.objectContaining({
                path: ["statusManagement"],
                message:
                    "statusManagement must be enabled when activeCredentials is enabled.",
            }),
        ]);
    });

    test("accepts the single-active-credential policy", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            statusManagement: true,
            activeCredentials: { enabled: true, tracking: "internal" },
        });

        expect(result.success).toBe(true);
    });

    test("rejects the unsupported maxActive option", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            statusManagement: true,
            activeCredentials: { enabled: true, maxActive: 2 },
        });

        expect(result.success).toBe(false);
    });

    test("allows an existing policy to be cleared", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            activeCredentials: null,
        });

        expect(result.success).toBe(true);
    });
});
