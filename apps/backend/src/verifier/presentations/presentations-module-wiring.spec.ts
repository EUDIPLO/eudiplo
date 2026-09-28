import { Test } from "@nestjs/testing";
import { base64url } from "jose";
import { describe, expect, it, vi } from "vitest";
import { CredentialVerifierFormatRegistry } from "./application/credential-verifier-format-registry.js";
import { VerifyPresentationResponse } from "./application/verify-presentation-response.js";
import { PRESENTATION_SETTINGS } from "./presentation-settings.js";
import { verifyPresentationResponseProvider } from "./presentations.module.js";
import { TrustedAuthoritiesService } from "./trusted-authorities.service.js";

const encode = (value: unknown) =>
    base64url.encode(Buffer.from(JSON.stringify(value)));

describe("PresentationsModule wiring", () => {
    it("constructs VerifyPresentationResponse with formats, trust lists and settings", async () => {
        const verify = vi.fn().mockResolvedValue({
            verified: true,
            claims: { age_over_18: true },
            missingClaims: [],
        });
        const resolveTrustListRefsForTenant = vi.fn().mockResolvedValue([]);
        const moduleRef = await Test.createTestingModule({
            providers: [
                {
                    provide: CredentialVerifierFormatRegistry,
                    useValue: new CredentialVerifierFormatRegistry([
                        { format: "mso_mdoc", verify },
                    ]),
                },
                {
                    provide: TrustedAuthoritiesService,
                    useValue: { resolveTrustListRefsForTenant },
                },
                {
                    provide: PRESENTATION_SETTINGS,
                    useValue: { publicUrl: "https://eudiplo.example" },
                },
                verifyPresentationResponseProvider,
            ],
        }).compile();

        const credentials = [{ id: "mdl", format: "mso_mdoc" }];
        const result = await moduleRef
            .get(VerifyPresentationResponse)
            .execute(
                { vp_token: { mdl: ["dr"] } },
                { tenantId: "tenant", dcql_query: { credentials } },
                {
                    id: "session",
                    tenantId: "tenant",
                    requestObject: `${encode({})}.${encode({ dcql_query: { credentials } })}.sig`,
                } as any,
            );

        expect(result).toEqual([
            { id: "mdl", values: [{ age_over_18: true }] },
        ]);
        expect(resolveTrustListRefsForTenant).toHaveBeenCalledWith(
            undefined,
            "tenant",
            "https://eudiplo.example/issuers/tenant",
        );
    });
});
