import { type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { JwtAuthGuard, NOT_A_JWT_MESSAGE } from "./auth.guard.js";

function contextWith(authorization?: string): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ headers: { authorization } }),
        }),
    } as unknown as ExecutionContext;
}

describe("JwtAuthGuard", () => {
    const guard = new JwtAuthGuard(new Reflector());

    it.each([
        "Bearer opaque-access-token",
        "bearer abc.def",
        "Bearer a.b.c.d.e",
    ])("names a bearer token that is no JWT: %s", (authorization) => {
        expect(() =>
            guard.handleRequest(
                undefined,
                false,
                undefined,
                contextWith(authorization),
            ),
        ).toThrow(new UnauthorizedException(NOT_A_JWT_MESSAGE));
    });

    it.each([
        undefined,
        "Bearer header.payload.signature",
        "Basic dXNlcjpwYXNz",
    ])("keeps the generic refusal for %s", (authorization) => {
        let refusal: unknown;
        try {
            guard.handleRequest(
                undefined,
                false,
                undefined,
                contextWith(authorization),
            );
        } catch (error) {
            refusal = error;
        }
        expect(refusal).toBeInstanceOf(UnauthorizedException);
        expect((refusal as UnauthorizedException).message).not.toBe(
            NOT_A_JWT_MESSAGE,
        );
    });

    it("passes on the strategy's reason for refusing a token", () => {
        const reason = new UnauthorizedException("Not an access token");
        expect(() =>
            guard.handleRequest(
                undefined,
                false,
                reason,
                contextWith("Bearer header.payload.signature"),
            ),
        ).toThrow(reason);
    });

    it("prefers an error of the strategy over its reason", () => {
        const error = new UnauthorizedException("Access token has no expiry");
        expect(() =>
            guard.handleRequest(
                error,
                false,
                new UnauthorizedException("Not an access token"),
                contextWith("Bearer header.payload.signature"),
            ),
        ).toThrow(error);
    });

    it("keeps the generic refusal for errors of the token library", () => {
        expect(() =>
            guard.handleRequest(
                undefined,
                false,
                new Error("jwt audience invalid. expected: eudiplo-api"),
                contextWith("Bearer header.payload.signature"),
            ),
        ).toThrow(new UnauthorizedException());
    });

    it("lets a verified token through", () => {
        const user = { roles: [] };
        expect(
            guard.handleRequest(
                undefined,
                user,
                undefined,
                contextWith("Bearer x"),
            ),
        ).toBe(user);
    });
});
