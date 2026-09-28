import { describe, expect, it } from "vitest";
import {
    CredentialAuthorizationError,
    ResolveAuthorizedCredentialConfiguration,
} from "./resolve-authorized-credential-configuration.js";

describe("ResolveAuthorizedCredentialConfiguration", () => {
    const useCase = new ResolveAuthorizedCredentialConfiguration();

    it("uses a directly requested credential configuration when authorization details are absent", () => {
        expect(useCase.execute({ credentialConfigurationId: "pid" })).toBe(
            "pid",
        );
    });

    it("resolves a credential identifier from matching authorization details", () => {
        expect(
            useCase.execute({
                credentialIdentifier: "credential-1",
                authorizationDetails: [
                    {
                        type: "openid_credential",
                        credential_configuration_id: "pid",
                        credential_identifiers: ["credential-1"],
                    },
                ],
            }),
        ).toBe("pid");
    });

    it("returns the protocol unknown-identifier error for an unbound identifier", () => {
        expect(() =>
            useCase.execute({
                credentialIdentifier: "missing",
                authorizationDetails: [],
            }),
        ).toThrowError(
            expect.objectContaining({ code: "unknown_credential_identifier" }),
        );
    });

    it("rejects credentials outside token authorization details", () => {
        expect(() =>
            useCase.execute({
                credentialConfigurationId: "mdl",
                authorizationDetails: [
                    {
                        type: "openid_credential",
                        credential_configuration_id: "pid",
                    },
                ],
            }),
        ).toThrowError(
            expect.objectContaining({
                code: "invalid_credential_request",
                message:
                    "Access token is not authorized for credential_configuration_id 'mdl'",
            }),
        );
    });

    it("rejects tokens with authorization details that authorize no credentials", () => {
        try {
            useCase.execute({
                credentialConfigurationId: "pid",
                authorizationDetails: [{ type: "openid4vp" }],
            });
            throw new Error("Expected authorization error");
        } catch (error) {
            expect(error).toBeInstanceOf(CredentialAuthorizationError);
            expect(error).toMatchObject({
                code: "invalid_credential_request",
                message:
                    "Access token is not authorized for any credential configuration",
            });
        }
    });
});
