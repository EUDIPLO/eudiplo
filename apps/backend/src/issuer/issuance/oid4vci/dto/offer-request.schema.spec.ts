import { describe, expect, it } from "vitest";
import { OfferRequestSchema } from "./offer-request.schema.js";

describe("OfferRequestSchema webhook claim source", () => {
    const body = (url: string) => ({
        response_type: "uri",
        flow: "pre_authorized_code",
        credentialConfigurationIds: ["pid"],
        credentialClaims: {
            pid: { type: "webhook", webhook: { url, auth: { type: "none" } } },
        },
    });

    it("accepts a webhook claim source", () => {
        expect(
            OfferRequestSchema.safeParse(body("https://hooks.example")).success,
        ).toBe(true);
    });

    it("rejects a webhook claim source with an empty URL", () => {
        const result = OfferRequestSchema.safeParse(body(""));

        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain('"url"');
    });
});
