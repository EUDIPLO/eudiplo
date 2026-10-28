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

const publicUrl = "https://issuer.example";
const configs = [
    {
        id: "mdl",
        config: { format: "mso_mdoc", docType: "org.iso.18013.5.1.mDL" },
    },
    {
        id: "pid",
        config: { format: "dc+sd-jwt" },
        vct: "urn:eudi:pid:de:1",
        schemaMeta: { id: "https://schemas.example/pid", version: "1.0" },
    },
    {
        id: "pid-copy",
        config: { format: "dc+sd-jwt" },
        vct: "urn:eudi:pid:de:1",
    },
    {
        id: "hosted",
        config: { format: "dc+sd-jwt" },
        vct: { name: "Hosted" },
    },
    { id: "other", config: { format: "jwt_vc" }, vct: "urn:other" },
    { id: "none", config: { format: "dc+sd-jwt" }, vct: null },
    { id: "blank-vct", config: { format: "dc+sd-jwt" }, vct: " " },
    { id: "blank", config: { format: "mso_mdoc", docType: " " } },
    { id: "padded", config: { format: "dc+sd-jwt" }, vct: " urn:padded " },
];
const types = [
    " urn:padded ",
    "https://issuer.example/issuers/t/credentials-metadata/vct/hosted",
    "org.iso.18013.5.1.mDL",
    "urn:eudi:pid:de:1",
];

describe("issuer registration certificate material", () => {
    it("derives the sorted vct and docType values as stored, not schema metadata", () => {
        expect(
            deriveRegistrationCertificateMaterial(configs, publicUrl, "t"),
        ).toEqual({ providesAttestations: types });
    });

    it("finds nothing without a vct or docType", () => {
        expect(
            deriveRegistrationCertificateMaterial(
                configs.filter((config) =>
                    ["other", "none", "blank-vct", "blank"].includes(config.id),
                ),
                publicUrl,
                "t",
            ),
        ).toEqual({ providesAttestations: [] });
    });

    it("fingerprints the provided attestations and settings", () => {
        const material = deriveRegistrationCertificateMaterial(
            configs,
            publicUrl,
            "t",
        );
        const expected = JSON.stringify({
            mode: "generate",
            providesAttestations: types,
            privacyPolicy: "https://p",
            supportUri: undefined,
        });
        expect(
            registrationCertificateFingerprint(
                { mode: "generate", privacyPolicy: "https://p" },
                material,
            ),
        ).toBe(createHash("sha256").update(expected).digest("hex"));
    });

    it("checks the validity window with clock skew", () => {
        expect(isJwtActive(active)).toBe(true);
        expect(isJwtActive(expired)).toBe(false);
        expect(isJwtActive(jwt({ nbf: now() + 3600 }))).toBe(false);
        expect(isJwtActive("not-a-jwt")).toBe(false);
    });
});

describe("RegistrarIssuerRegistrationCertificateProvider", () => {
    function setup(
        cache?: { jwt: string; fingerprint: string } | null,
        credentialConfigs: unknown[] = configs,
    ) {
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
                getCredentialConfigsForTenant: async () => credentialConfigs,
            } as unknown as CredentialsService,
            issuance as unknown as IssuanceService,
            publicUrl,
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
            deriveRegistrationCertificateMaterial(configs, publicUrl, "t"),
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
                    provides_attestations: types,
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

    it("requests nothing without a vct or docType", async () => {
        const { provider, registrar } = setup(undefined, [
            { id: "none", config: { format: "dc+sd-jwt" }, vct: null },
        ]);
        await expect(
            provider.resolve("t", { mode: "generate" }),
        ).resolves.toBeUndefined();
        expect(registrar.resolveRegistrationCertificate).not.toHaveBeenCalled();
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
