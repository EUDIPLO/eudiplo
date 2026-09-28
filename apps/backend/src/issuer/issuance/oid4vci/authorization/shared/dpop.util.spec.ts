import { describe, expect, it, vi } from "vitest";
import { dpopProofExpiresAt, dpopProofVerification } from "./dpop.util.js";

describe("dpopProofExpiresAt", () => {
    it("keeps the proof until iat plus the maximum age and clock skew", () => {
        expect(dpopProofExpiresAt(1_000, new Date(0))).toEqual(
            new Date((1_000 + 300 + 60) * 1000),
        );
    });

    it("covers a proof issued within the allowed skew in the future", () => {
        const now = new Date(1_000_000);
        const iat = 1_000 + 60;
        // The library accepts this proof until iat + 300 + 60 seconds.
        expect(dpopProofExpiresAt(iat, now).getTime()).toBe((iat + 360) * 1000);
    });

    it("starts the window at now without iat", () => {
        expect(dpopProofExpiresAt(undefined, new Date(5_000))).toEqual(
            new Date(5_000 + 360_000),
        );
        expect(dpopProofExpiresAt(Number.NaN, new Date(5_000))).toEqual(
            new Date(5_000 + 360_000),
        );
    });
});

describe("dpopProofVerification", () => {
    it("passes the freshness window and a jti check bound to the registry", async () => {
        const registry = { register: vi.fn().mockResolvedValue(true) };
        const options = dpopProofVerification(registry);

        expect(options).toMatchObject({
            maxProofAgeSeconds: 300,
            allowedClockSkewSeconds: 60,
        });
        await expect(
            options.assertJtiUniqueness({
                header: {} as never,
                payload: { jti: "jti-1", iat: 1_000 } as never,
                signature: "",
                jwkThumbprint: "jkt-1",
                now: new Date(1_000_000),
            }),
        ).resolves.toBe(true);
        expect(registry.register).toHaveBeenCalledWith(
            "jkt-1",
            "jti-1",
            new Date(1_360_000),
        );
    });

    it("reports a replay when the registry already knows the proof", async () => {
        const registry = { register: vi.fn().mockResolvedValue(false) };
        await expect(
            dpopProofVerification(registry).assertJtiUniqueness({
                header: {} as never,
                payload: { jti: "jti-1", iat: 1_000 } as never,
                signature: "",
                jwkThumbprint: "jkt-1",
                now: new Date(1_000_000),
            }),
        ).resolves.toBe(false);
    });
});
