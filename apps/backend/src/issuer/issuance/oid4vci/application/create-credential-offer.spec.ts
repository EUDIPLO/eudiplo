import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionOfferRequest } from "../../../../session/domain/session-data.js";
import { CreateCredentialOffer } from "./create-credential-offer.js";

function fixture(offerLifetimeSeconds?: number | null) {
    const events: string[] = [];
    const execute = vi.fn().mockImplementation(async (input) => {
        events.push("create");
        return input;
    });
    const update = vi.fn().mockImplementation(async () => {
        events.push("update");
    });
    const selectAuthorizationServer = {
        execute: vi.fn().mockResolvedValue({
            issuer: "https://as.example",
            sessionServerId: "selected",
        }),
    };
    const protocol = {
        validateClaims: vi.fn().mockImplementation(async () => {
            events.push("validate");
        }),
        encode: vi.fn().mockImplementation(async () => {
            events.push("encode");
            return {
                object: {
                    credential_issuer: "https://issuer.example",
                    credential_configuration_ids: ["pid"],
                },
                uri: "openid-credential-offer://offer",
            };
        }),
    };
    const issuanceConfigs = {
        getForTenant: vi.fn().mockResolvedValue({ offerLifetimeSeconds }),
    };
    const ids = vi
        .fn()
        .mockReturnValueOnce("session")
        .mockReturnValueOnce("code");
    return {
        events,
        execute,
        update,
        protocol,
        ids,
        issuanceConfigs,
        useCase: new CreateCredentialOffer(
            { execute },
            { updateForTenant: update },
            selectAuthorizationServer,
            protocol,
            ids,
            issuanceConfigs,
        ),
    };
}

describe("CreateCredentialOffer", () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    const request: SessionOfferRequest = {
        response_type: "uri",
        flow: "pre_authorized_code",
        credentialConfigurationIds: ["pid"],
        credentialClaims: {
            pid: { type: "inline", claims: { name: "Alice" } },
        },
        tx_code: "1234",
    };
    it("validates before persistence and persists the encoded offer afterward", async () => {
        const f = fixture();
        await expect(f.useCase.execute("tenant", request)).resolves.toEqual({
            session: "session",
            uri: "openid-credential-offer://offer",
        });
        expect(f.events).toEqual(["validate", "create", "encode", "update"]);
        expect(f.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: "tenant",
                id: "session",
                authorization_code: "code",
                authorizationServerId: "selected",
            }),
        );
        expect(f.protocol.encode.mock.calls[0][2]).toMatchObject({
            "urn:ietf:params:oauth:grant-type:pre-authorized_code": {
                "pre-authorized_code": "code",
                tx_code: { length: 4, input_mode: "numeric" },
            },
        });
    });
    it("stores the offered configuration ids and the reference in plaintext", async () => {
        const f = fixture();
        await f.useCase.execute("tenant", {
            ...request,
            credentialConfigurationIds: ["pid", "mdl"],
            credentialClaims: undefined,
            reference: "order-4711",
        });
        expect(f.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                credentialConfigurationIds: ["pid", "mdl"],
                reference: "order-4711",
            }),
        );
    });
    it("builds authorization-code offers without a pre-authorized code", async () => {
        const f = fixture();
        await f.useCase.execute("tenant", {
            ...request,
            flow: "authorization_code",
            credentialClaims: {
                pid: {
                    type: "attributeProvider",
                    attributeProviderId: "provider",
                },
            },
        });
        expect(f.ids).toHaveBeenCalledOnce();
        expect(f.protocol.validateClaims).not.toHaveBeenCalled();
        expect(f.protocol.encode.mock.calls[0][2]).toEqual({
            authorization_code: {
                issuer_state: "session",
                authorization_server: "https://as.example",
            },
        });
    });
    it("does not persist after claim validation fails", async () => {
        const f = fixture();
        f.protocol.validateClaims.mockRejectedValue(
            new Error("invalid claims"),
        );
        await expect(f.useCase.execute("tenant", request)).rejects.toThrow(
            "invalid claims",
        );
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.protocol.encode).not.toHaveBeenCalled();
    });
    it("preserves the created session after encoding fails without saving an offer", async () => {
        const f = fixture();
        f.protocol.encode.mockRejectedValue(new Error("invalid configuration"));
        await expect(f.useCase.execute("tenant", request)).rejects.toThrow(
            "invalid configuration",
        );
        expect(f.execute).toHaveBeenCalledOnce();
        expect(f.update).not.toHaveBeenCalled();
    });

    it("keeps offers without a configured or requested lifetime unbounded", async () => {
        const f = fixture();
        await f.useCase.execute("tenant", request);
        expect(f.execute.mock.calls[0][0]).not.toHaveProperty("expiresAt");
    });
    it("expires the offer after the configured lifetime", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
        const f = fixture(600);
        await f.useCase.execute("tenant", request);
        expect(f.issuanceConfigs.getForTenant).toHaveBeenCalledWith("tenant");
        expect(f.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                expiresAt: new Date("2026-01-01T12:10:00Z"),
            }),
        );
    });
    it("lets the offer request override the configured lifetime", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
        const f = fixture(600);
        await f.useCase.execute("tenant", {
            ...request,
            offerLifetimeSeconds: 30,
        });
        expect(f.issuanceConfigs.getForTenant).not.toHaveBeenCalled();
        expect(f.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                expiresAt: new Date("2026-01-01T12:00:30Z"),
            }),
        );
    });
});
