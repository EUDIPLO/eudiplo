import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { InvalidCredentialClaims } from "../domain/credential-claims-validation.js";
import { CredentialIssuerFormatRegistry } from "./credential-issuer-format-registry.js";
import { IssueCredential } from "./issue-credential.js";

function fixture(source?: unknown) {
    const session = {
        id: "session",
        tenantId: "tenant",
        credentialPayload: {
            credentialClaims: source ? { pid: source } : undefined,
        },
    } as SessionData;
    const configuration = {
        id: "pid",
        tenantId: "tenant",
        config: { format: "test", display: [] },
        fields: [{ path: ["name"], type: "string", defaultValue: "static" }],
        attributeProviderId: "provider",
    };
    const configs = {
        getForTenant: vi.fn().mockResolvedValue(configuration),
    };
    const federation = {
        entityIdForTenant: vi
            .fn()
            .mockResolvedValue("https://federation.example"),
    };
    const issue = vi.fn().mockResolvedValue("signed");
    const useCase = new IssueCredential(
        configs,
        federation,
        new CredentialIssuerFormatRegistry([{ format: "test", issue }]),
    );
    const command = {
        credentialConfigurationId: "pid",
        holderKey: { kty: "EC" },
        session,
        issuanceSetId: "set",
    };
    return {
        session,
        configuration,
        configs,
        federation,
        issue,
        useCase,
        command,
    };
}

describe("IssueCredential", () => {
    it("issues the resolved claims and dispatches a third format without HTTP", async () => {
        const f = fixture({ type: "inline", claims: { name: "inline" } });
        await expect(
            f.useCase.execute({
                ...f.command,
                preloadedClaims: { name: "resolved" },
            }),
        ).resolves.toBe("signed");
        expect(f.configs.getForTenant).toHaveBeenCalledWith("tenant", "pid");
        expect(f.issue).toHaveBeenCalledWith({
            credentialConfiguration: f.configuration,
            holderKey: f.command.holderKey,
            session: f.session,
            claims: { name: "resolved" },
            federationEntityId: "https://federation.example",
            issuanceSetId: "set",
        });
    });

    // Claim sources are resolved before issuance (CredentialClaimsProvider);
    // without resolved claims no dynamic source applies.
    it("issues the static defaults without resolved claims", async () => {
        const f = fixture();
        f.federation.entityIdForTenant.mockRejectedValue(
            new Error("missing settings"),
        );
        await f.useCase.execute(f.command);
        expect(f.issue).toHaveBeenCalledWith(
            expect.objectContaining({
                claims: { name: "static" },
                federationEntityId: undefined,
            }),
        );
    });

    it("propagates configuration failures without issuing", async () => {
        const f = fixture();
        const failure = new Error("storage failed");
        f.configs.getForTenant.mockRejectedValueOnce(failure);
        await expect(f.useCase.execute(f.command)).rejects.toBe(failure);
        expect(f.issue).not.toHaveBeenCalled();
    });

    it("rejects resolved claims that do not match the configuration before signing", async () => {
        const f = fixture();

        await expect(
            f.useCase.execute({
                ...f.command,
                preloadedClaims: { name: "remote", nickname: "x" },
            }),
        ).rejects.toBeInstanceOf(InvalidCredentialClaims);
        expect(f.issue).not.toHaveBeenCalled();
    });
});
