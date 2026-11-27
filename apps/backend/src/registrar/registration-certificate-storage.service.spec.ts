import { BadGatewayException, BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RegistrationCertificateStorage } from "./registration-certificate-storage.service.js";

const settings = {
    publicUrl: "https://eudiplo.example",
    skipOveraskingCheck: false,
};
const actor = { entity: { id: "t" } } as never;
const request = {
    credentialTypes: {
        providesAttestations: [{ format: "dc+sd-jwt" as const, type: "urn:a" }],
    },
};

describe("RegistrationCertificateStorage", () => {
    it("revokes an issuer certificate that is not a JWT instead of storing it", async () => {
        const issuance = { storeIssuanceConfiguration: vi.fn() };
        const storage = new RegistrationCertificateStorage(
            {} as never,
            issuance as never,
            settings,
        );
        const revoke = vi.fn().mockResolvedValue(undefined);

        await expect(
            storage.storeIssuer(
                "t",
                request,
                { registrar: "Test", id: "rc", value: "not-a-jwt", revoke },
                actor,
            ),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(revoke).toHaveBeenCalledOnce();
        expect(issuance.storeIssuanceConfiguration).not.toHaveBeenCalled();
    });

    it("refuses a verifier request without purpose or privacy policy, given or kept", async () => {
        const storage = new RegistrationCertificateStorage(
            {
                getPresentationConfig: vi.fn().mockResolvedValue({
                    id: "age",
                    dcql_query: { credentials: [] },
                    registration_cert: { privacy_policy: "https://p" },
                }),
            } as never,
            {} as never,
            settings,
        );

        await expect(
            storage.verifierRequest("t", "age", {}),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            storage.verifierRequest("t", "age", {
                purpose: [{ lang: "en", content: "Age check" }],
            }),
        ).resolves.toMatchObject({ privacyPolicy: "https://p" });
    });
});
