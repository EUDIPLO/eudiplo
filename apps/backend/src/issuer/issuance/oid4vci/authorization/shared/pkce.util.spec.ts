import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
    assertPkceCodeChallenge,
    verifyPkceCodeChallenge,
} from "./pkce.util.js";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const s256 = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("assertPkceCodeChallenge", () => {
    it("accepts an S256 challenge", () => {
        expect(() => assertPkceCodeChallenge(s256, "S256")).not.toThrow();
    });

    it("rejects a missing challenge or a non-S256 method with invalid_request", () => {
        for (const [challenge, method] of [
            [undefined, "S256"],
            [s256, undefined],
            [verifier, "plain"],
        ] as const) {
            let thrown: unknown;
            try {
                assertPkceCodeChallenge(challenge, method);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(BadRequestException);
            expect((thrown as BadRequestException).getResponse()).toMatchObject(
                { error: "invalid_request" },
            );
        }
    });
});

describe("verifyPkceCodeChallenge", () => {
    it("accepts a matching S256 verifier", () => {
        expect(() =>
            verifyPkceCodeChallenge(s256, "S256", verifier),
        ).not.toThrow();
    });

    it("rejects a session without an S256 challenge", () => {
        expect(() =>
            verifyPkceCodeChallenge(undefined, undefined, undefined),
        ).toThrow(BadRequestException);
        expect(() =>
            verifyPkceCodeChallenge(verifier, "plain", verifier),
        ).toThrow(BadRequestException);
    });

    it("rejects a missing or wrong verifier", () => {
        expect(() => verifyPkceCodeChallenge(s256, "S256", undefined)).toThrow(
            BadRequestException,
        );
        expect(() => verifyPkceCodeChallenge(s256, "S256", "wrong")).toThrow(
            UnauthorizedException,
        );
    });
});
