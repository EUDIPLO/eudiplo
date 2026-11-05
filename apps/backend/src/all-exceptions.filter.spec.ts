import {
    type ArgumentsHost,
    BadRequestException,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import {
    ClientIdTaken,
    ClientsManagedByIdentityProvider,
} from "./auth/client/domain/client-data.js";
import { TenantNotFound } from "./auth/tenant/domain/tenant-data.js";
import { CredentialConfigurationNotFound } from "./issuer/configuration/credentials/domain/credential-configuration.js";
import { IssuanceConfigurationNotFound } from "./issuer/configuration/issuance/domain/issuance-configuration.js";
import { TokenErrorException } from "./issuer/issuance/oid4vci/exceptions/token-error.exception.js";
import { SessionNotFound } from "./session/application/session-errors.js";

function respond(exception: unknown) {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
        switchToHttp: () => ({
            getResponse: () => ({ status }),
            getRequest: () => ({ method: "GET", path: "/x", url: "/x" }),
        }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

function statusFor(exception: unknown): number {
    return respond(exception).status;
}

describe("AllExceptionsFilter", () => {
    it.each([
        ["session", new SessionNotFound()],
        ["tenant", new TenantNotFound("t1")],
        ["issuance configuration", new IssuanceConfigurationNotFound("t1")],
        [
            "credential configuration",
            new CredentialConfigurationNotFound("t1", "c1"),
        ],
    ])("maps a missing %s to 404", (_name, error) => {
        expect(statusFor(error)).toBe(404);
    });

    it("maps a conflict to 409 and keeps its message in production", () => {
        vi.stubEnv("NODE_ENV", "production");
        try {
            const { status, body } = respond(new ClientIdTaken("c1"));
            expect(status).toBe(409);
            expect(body.message).toBe("Client ID 'c1' is already in use");
            expect(respond(new Error("internal detail")).body.message).toBe(
                "Internal Server Error",
            );
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("maps what the instance does not offer to 501 and keeps its message in production", () => {
        vi.stubEnv("NODE_ENV", "production");
        try {
            const { status, body } = respond(
                new ClientsManagedByIdentityProvider(),
            );
            expect(status).toBe(501);
            expect(body.message).toBe(
                "Clients are managed in the identity provider (OIDC_PROVIDER=generic).",
            );
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("keeps unknown errors as 500", () => {
        expect(statusFor(new Error("boom"))).toBe(500);
    });

    it("logs the description of an OAuth error and keeps its body", () => {
        const log = vi
            .spyOn(Logger.prototype, "error")
            .mockImplementation(() => undefined);
        try {
            const { status, body } = respond(
                new TokenErrorException(
                    "invalid_client",
                    "Wallet attestation is not trusted",
                    HttpStatus.UNAUTHORIZED,
                ),
            );
            expect(status).toBe(401);
            expect(body).toMatchObject({
                error: "invalid_client",
                error_description: "Wallet attestation is not trusted",
            });
            expect(log.mock.calls[0][0]).toBe(
                '[GET] /x 401 - "Wallet attestation is not trusted"',
            );
            respond(new TokenErrorException("invalid_grant"));
            expect(log.mock.calls[1][0]).toBe('[GET] /x 400 - "invalid_grant"');
            respond(new BadRequestException("bad input"));
            expect(log.mock.calls[2][0]).toBe('[GET] /x 400 - "bad input"');
        } finally {
            log.mockRestore();
        }
    });
});
