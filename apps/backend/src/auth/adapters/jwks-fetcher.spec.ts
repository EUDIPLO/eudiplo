import { describe, expect, it, vi } from "vitest";
import { jwksFetcher } from "./jwks-fetcher.js";

describe("jwksFetcher", () => {
    const keys = [{ kty: "RSA", kid: "key-1", n: "n", e: "AQAB" }];

    function policyAnswering(status: number, body: string) {
        return { get: vi.fn(async () => ({ status, body, headers: {} })) };
    }

    it("fetches the key set through the outbound URL policy with the configured origins trusted", async () => {
        const policy = policyAnswering(200, JSON.stringify({ keys }));

        await expect(
            jwksFetcher(policy as never, ["https://auth.example.com"])(
                "https://keys.example.net/jwks",
            ),
        ).resolves.toEqual({ keys });
        expect(policy.get).toHaveBeenCalledWith(
            "https://keys.example.net/jwks",
            expect.objectContaining({
                maxBytes: 1024 * 1024,
                trustedOrigins: ["https://auth.example.com"],
            }),
        );
    });

    it("fails for a status other than 2xx", async () => {
        await expect(
            jwksFetcher(
                policyAnswering(503, "down") as never,
                [],
            )("https://keys.example.net/jwks"),
        ).rejects.toThrow(
            "The key set at https://keys.example.net/jwks answered with status code 503",
        );
    });

    it("fails when the policy refuses the URL", async () => {
        const policy = {
            get: vi.fn(async () => {
                throw new Error("Outbound URL resolves to a private address");
            }),
        };

        await expect(
            jwksFetcher(policy as never, [])("https://keys.example.net/jwks"),
        ).rejects.toThrow("private address");
    });
});
