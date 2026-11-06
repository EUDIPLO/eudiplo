import { HttpStatus, UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { toOAuthHttpError } from "../../exceptions/token-error.exception.js";
import {
    clientAttestationLogDetail,
    verifyClientAttestation,
} from "./client-attestation.js";
import { OAuthError } from "./oauth-error.js";

describe("verifyClientAttestation", () => {
    const rejected = () =>
        Promise.reject(
            new UnauthorizedException(
                "Wallet provider certificate is not trusted - no matching entity in trust list",
            ),
        );

    it.each([
        { endpoint: "par" as const, status: HttpStatus.BAD_REQUEST },
        { endpoint: "token" as const, status: HttpStatus.UNAUTHORIZED },
    ])(
        "answers a rejected attestation at $endpoint with invalid_client and HTTP $status",
        async ({ endpoint, status }) => {
            const error = await verifyClientAttestation(
                endpoint,
                rejected,
                "tenant t",
            ).catch((e) => e);

            expect(error).toBeInstanceOf(OAuthError);
            expect(error.logDetail).toContain(
                "tenant t: Wallet provider certificate is not trusted",
            );

            // The reason is logged, not returned.
            const logger = { warn: vi.fn(), error: vi.fn() };
            const response = toOAuthHttpError(error, logger) as {
                getStatus(): number;
                getResponse(): unknown;
            };
            expect(response.getStatus()).toBe(status);
            expect(response.getResponse()).toEqual({
                error: "invalid_client",
                error_description: "Client attestation validation failed",
            });
            expect(logger.warn).toHaveBeenCalledWith(error.logDetail);
        },
    );

    it("rejects the client on any error of the check", async () => {
        await expect(
            verifyClientAttestation(
                "token",
                () => Promise.reject(new Error("trust list unavailable")),
                "tenant t",
            ),
        ).rejects.toMatchObject({ code: "invalid_client" });
    });

    it("logs Unknown error for a rejection that is not an Error", async () => {
        await expect(
            verifyClientAttestation(
                "par",
                () => Promise.reject("x"),
                "tenant t",
            ),
        ).rejects.toMatchObject({
            logDetail: expect.stringMatching(/Unknown error$/),
        });
    });

    it("logs the reason that a fixed message keeps as cause", async () => {
        const reason =
            "Failed to fetch trust list from http://eudiplo-internal:3000/issuers/t/trust-list/w: connect ECONNREFUSED";
        const error = await verifyClientAttestation(
            "par",
            () =>
                Promise.reject(
                    new UnauthorizedException(
                        "Wallet provider trust lists could not be loaded",
                        { cause: new Error(reason) },
                    ),
                ),
            "tenant t",
        ).catch((e) => e);

        expect(error.logDetail).toBe(
            `Client attestation validation failed for tenant t: Wallet provider trust lists could not be loaded: ${reason}`,
        );
    });

    it("resolves when the attestation is accepted", async () => {
        await expect(
            verifyClientAttestation("par", async () => undefined, "tenant t"),
        ).resolves.toBeUndefined();
    });
});

describe("clientAttestationLogDetail", () => {
    const prefix = "Client attestation validation failed for tenant t: ";

    it("adds a cause that the message hides", () => {
        expect(
            clientAttestationLogDetail(
                "tenant t",
                new Error("Wallet attestation verification failed", {
                    cause: new Error("list at http://internal unreachable"),
                }),
            ),
        ).toBe(
            `${prefix}Wallet attestation verification failed: list at http://internal unreachable`,
        );
    });

    it("does not repeat a cause that the message already names", () => {
        expect(
            clientAttestationLogDetail(
                "tenant t",
                new Error(
                    "Wallet attestation verification failed: jwt has expired",
                    { cause: new Error("jwt has expired") },
                ),
            ),
        ).toBe(
            `${prefix}Wallet attestation verification failed: jwt has expired`,
        );
    });

    it("gives the message of an error without cause", () => {
        expect(
            clientAttestationLogDetail(
                "tenant t",
                new Error("Wallet provider certificate is not trusted"),
            ),
        ).toBe(`${prefix}Wallet provider certificate is not trusted`);
    });

    it("says Unknown error for a value that is not an Error", () => {
        expect(clientAttestationLogDetail("tenant t", "x")).toBe(
            `${prefix}Unknown error`,
        );
    });
});
