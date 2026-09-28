import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RegistrarService } from "../../../../registrar/registrar.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import {
    deriveRegistrationCertificateMaterial,
    isJwtActive,
    registrationCertificateFingerprint,
} from "../domain/issuer-registration-certificate.js";
import { RegistrarIssuerRegistrationCertificateProvider } from "./registrar-issuer-registration-certificate-provider.js";

const now = () => Math.floor(Date.now() / 1000);
const jwt = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const active = jwt({ exp: now() + 3600, id: "active" });
const expired = jwt({ exp: now() - 3600 });

const configs = [
    { id: "mdl", config: { format: "mso_mdoc" }, schemaMeta: { id: " b " } },
    {
        id: "pid",
        config: { format: "dc+sd-jwt" },
        schemaMeta: { id: "a", version: "1.0" },
    },
    { id: "other", config: { format: "jwt_vc" }, schemaMeta: { id: "c" } },
    { id: "none", config: { format: "dc+sd-jwt" }, schemaMeta: null },
];

describe("issuer registration certificate material", () => {
    it("derives sorted attestations for SD-JWT VC and mdoc configurations", () => {
        expect(deriveRegistrationCertificateMaterial(configs)).toEqual({
            schemaMetadataIds: ["a", "b"],
            providedAttestations: [
                {
                    credentialConfigId: "pid",
                    format: "dc+sd-jwt",
                    meta: {
                        schema_metadata_id: "a",
                        schema_metadata_version: "1.0",
                    },
                },
                {
                    credentialConfigId: "mdl",
                    format: "mso_mdoc",
                    meta: { schema_metadata_id: "b" },
                },
            ],
        });
    });

    it("keeps the fingerprint format used by cached certificates", () => {
        const material = deriveRegistrationCertificateMaterial(configs);
        // Persisted caches compare against this exact serialization.
        const historical = JSON.stringify({
            mode: "generate",
            schemaMetadataIds: material.schemaMetadataIds,
            privacyPolicy: "https://p",
            supportUri: undefined,
            providedAttestations: material.providedAttestations,
        });
        expect(
            registrationCertificateFingerprint(
                { mode: "generate", privacyPolicy: "https://p" },
                material,
            ),
        ).toBe(createHash("sha256").update(historical).digest("hex"));
    });

    it("checks the validity window with clock skew", () => {
        expect(isJwtActive(active)).toBe(true);
        expect(isJwtActive(expired)).toBe(false);
        expect(isJwtActive(jwt({ nbf: now() + 3600 }))).toBe(false);
        expect(isJwtActive("not-a-jwt")).toBe(false);
    });
});

describe("RegistrarIssuerRegistrationCertificateProvider", () => {
    function setup(cache?: { jwt: string; fingerprint: string } | null) {
        const registrar = {
            resolveRegistrationCertificate: vi.fn(async () => ({
                jwt: active,
                payload: { iat: 1, exp: 2 },
            })),
            revokeRegistrationCertificateByJwt: vi.fn(async () => true),
        };
        const issuance = {
            getIssuanceConfiguration: vi.fn(async () => ({
                registrationCertificateCache: cache,
            })),
            updateRegistrationCertificateCache: vi.fn(),
        };
        const provider = new RegistrarIssuerRegistrationCertificateProvider(
            registrar as unknown as RegistrarService,
            {
                getCredentialConfigsForTenant: async () => configs,
            } as unknown as CredentialsService,
            issuance as unknown as IssuanceService,
        );
        return { provider, registrar, issuance };
    }

    it("returns an active imported certificate only", async () => {
        const { provider } = setup();
        await expect(
            provider.resolve("t", { mode: "import", jwt: active }),
        ).resolves.toBe(active);
        await expect(
            provider.resolve("t", { mode: "import", jwt: expired }),
        ).resolves.toBeUndefined();
        await expect(
            provider.resolve("t", { mode: "import" }),
        ).resolves.toBeUndefined();
    });

    it("reuses a cached certificate with a matching fingerprint", async () => {
        const settings = { mode: "generate" as const };
        const fingerprint = registrationCertificateFingerprint(
            settings,
            deriveRegistrationCertificateMaterial(configs),
        );
        const cached = jwt({ exp: now() + 60, id: "cached" });
        const { provider, registrar } = setup({ jwt: cached, fingerprint });

        await expect(provider.resolve("t", settings)).resolves.toBe(cached);
        expect(registrar.resolveRegistrationCertificate).not.toHaveBeenCalled();
    });

    it("requests a new certificate, revokes the replaced one and updates the cache", async () => {
        const previous = jwt({ exp: now() + 60, id: "previous" });
        const { provider, registrar, issuance } = setup({
            jwt: previous,
            fingerprint: "outdated",
        });

        await expect(
            provider.resolve("t", {
                mode: "generate",
                privacyPolicy: "https://privacy",
            }),
        ).resolves.toBe(active);

        expect(registrar.resolveRegistrationCertificate).toHaveBeenCalledWith(
            {
                body: {
                    provides_attestations: ["a", "b"],
                    privacy_policy: "https://privacy",
                },
            },
            {},
            expect.any(String),
            "t",
        );
        expect(
            registrar.revokeRegistrationCertificateByJwt,
        ).toHaveBeenCalledWith("t", previous);
        expect(
            issuance.updateRegistrationCertificateCache,
        ).toHaveBeenCalledWith(
            "t",
            expect.objectContaining({ jwt: active, issuedAt: 1, expiresAt: 2 }),
        );
    });

    it("never fails metadata generation", async () => {
        const { provider, registrar } = setup();
        registrar.resolveRegistrationCertificate.mockRejectedValue(
            new Error("registrar down"),
        );
        await expect(
            provider.resolve("t", { mode: "generate" }),
        ).resolves.toBeUndefined();
    });
});
