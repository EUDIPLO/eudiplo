import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../session/domain/session-data.js";
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
        findForTenant: vi.fn(),
        listForTenant: vi.fn(),
        findAttributeProvider: vi.fn().mockResolvedValue({
            url: "https://configured.example",
            auth: { type: "none" },
        }),
    };
    const claims = { resolve: vi.fn().mockResolvedValue({ name: "remote" }) };
    const federation = {
        entityIdForTenant: vi
            .fn()
            .mockResolvedValue("https://federation.example"),
    };
    const issue = vi.fn().mockResolvedValue("signed");
    const useCase = new IssueCredential(
        configs,
        claims,
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
        claims,
        federation,
        issue,
        useCase,
        command,
    };
}

describe("IssueCredential", () => {
    it("gives preloaded claims precedence and dispatches a third format without HTTP", async () => {
        const f = fixture({ type: "inline", claims: { name: "inline" } });
        await expect(
            f.useCase.execute({ ...f.command, preloadedClaims: {} }),
        ).resolves.toBe("signed");
        expect(f.configs.getForTenant).toHaveBeenCalledWith("tenant", "pid");
        expect(f.claims.resolve).not.toHaveBeenCalled();
        expect(f.configs.findAttributeProvider).not.toHaveBeenCalled();
        expect(f.issue).toHaveBeenCalledWith({
            credentialConfiguration: f.configuration,
            holderKey: f.command.holderKey,
            session: f.session,
            claims: {},
            federationEntityId: "https://federation.example",
            issuanceSetId: "set",
        });
    });
    it("uses inline claims before configured providers", async () => {
        const f = fixture({ type: "inline", claims: { name: "inline" } });
        await f.useCase.execute(f.command);
        expect(f.issue).toHaveBeenCalledWith(
            expect.objectContaining({ claims: { name: "inline" } }),
        );
        expect(f.claims.resolve).not.toHaveBeenCalled();
    });
    it("uses offer-time webhooks before configured providers", async () => {
        const webhook = {
            url: "https://offer.example",
            auth: { type: "none" },
        };
        const f = fixture({ type: "webhook", webhook });
        await f.useCase.execute(f.command);
        expect(f.claims.resolve).toHaveBeenCalledWith(
            webhook,
            f.session,
            "pid",
        );
        expect(f.configs.findAttributeProvider).not.toHaveBeenCalled();
    });
    it("looks up configured providers within the session tenant", async () => {
        const f = fixture();
        await f.useCase.execute(f.command);
        expect(f.configs.findAttributeProvider).toHaveBeenCalledWith(
            "tenant",
            "provider",
        );
        expect(f.issue).toHaveBeenCalledWith(
            expect.objectContaining({ claims: { name: "remote" } }),
        );
    });
    it.each(["missing provider", "missing remote claims"])(
        "preserves static fallback for %s",
        async (reason) => {
            const f = fixture();
            if (reason === "missing provider")
                f.configs.findAttributeProvider.mockResolvedValue(null);
            else f.claims.resolve.mockResolvedValue(undefined);
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
        },
    );
    it("propagates configuration and delivery failures without issuing", async () => {
        const f = fixture();
        const failure = new Error("storage failed");
        f.configs.getForTenant.mockRejectedValueOnce(failure);
        await expect(f.useCase.execute(f.command)).rejects.toBe(failure);
        f.claims.resolve.mockRejectedValueOnce(failure);
        await expect(f.useCase.execute(f.command)).rejects.toBe(failure);
        expect(f.issue).not.toHaveBeenCalled();
    });
});
