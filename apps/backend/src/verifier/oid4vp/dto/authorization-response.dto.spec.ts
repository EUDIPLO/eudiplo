import { describe, expect, it } from "vitest";
import { AuthorizationResponse } from "./authorization-response.dto";

describe("AuthorizationResponse", () => {
    it("accepts and strips additional authorization response parameters", () => {
        const result = AuthorizationResponse.schema.safeParse({
            error: "access_denied",
            state: "wallet-state",
            iss: "https://wallet.example.com/",
        });

        expect(result.success).toBe(true);

        if (!result.success) {
            return;
        }

        expect(result.data).toEqual({
            error: "access_denied",
            state: "wallet-state",
        });
    });
});
