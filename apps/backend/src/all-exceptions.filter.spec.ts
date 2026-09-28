import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { TenantNotFound } from "./auth/tenant/domain/tenant-data.js";
import { CredentialConfigurationNotFound } from "./issuer/configuration/credentials/domain/credential-configuration.js";
import { IssuanceConfigurationNotFound } from "./issuer/configuration/issuance/domain/issuance-configuration.js";
import { SessionNotFound } from "./session/application/session-errors.js";

function statusFor(exception: unknown): number {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
        switchToHttp: () => ({
            getResponse: () => ({ status }),
            getRequest: () => ({ method: "GET", path: "/x", url: "/x" }),
        }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return status.mock.calls[0][0];
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

    it("keeps unknown errors as 500", () => {
        expect(statusFor(new Error("boom"))).toBe(500);
    });
});
