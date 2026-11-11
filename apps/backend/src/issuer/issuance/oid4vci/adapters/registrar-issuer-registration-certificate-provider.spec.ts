import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RegistrarService } from "../../../../registrar/registrar.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import { IssuerRegistrationCertificateLock } from "../../../configuration/issuance/issuer-registration-certificate-lock.js";
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
    { format: "dc+sd-jwt", type: " urn:padded " },
    {
        format: "dc+sd-jwt",
        type: "https://issuer.example/issuers/t/credentials-metadata/vct/hosted",
    },
    { format: "mso_mdoc", type: "org.iso.18013.5.1.mDL" },
    { format: "dc+sd-jwt", type: "urn:eudi:pid:de:1" },
];

describe("issuer registration certificate material", () => {
    it("derives the sorted vct and docType values as stored, not schema metadata", () => {
        expect(
            deriveRegistrationCertificateMaterial(configs, publicUrl, "t"),
        ).toEqual({ providesAttestations: types });
    });

    it("keeps a type listed in both formats once per format", () => {
        expect(
            deriveRegistrationCertificateMaterial(
                [
                    { id: "a", config: { format: "mso_mdoc", docType: "x" } },
                    { id: "b", config: { format: "dc+sd-jwt" }, vct: "x" },
                    { id: "c", config: { format: "mso_mdoc", docType: "x" } },
                ],
                publicUrl,
                "t",
            ),
        ).toEqual({
            providesAttestations: [
                { format: "dc+sd-jwt", type: "x" },
                { format: "mso_mdoc", type: "x" },
            ],
        });
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

    it("fingerprints the provided types with their formats and the settings", () => {
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

    it("changes the fingerprint when a type changes its format", () => {
        const fingerprint = (format: string) =>
            registrationCertificateFingerprint(
                { mode: "generate" },
                deriveRegistrationCertificateMaterial(
                    [
                        format === "mso_mdoc"
                            ? { id: "x", config: { format, docType: "x" } }
                            : { id: "x", config: { format }, vct: "x" },
                    ],
                    publicUrl,
                    "t",
                ),
            );
        expect(fingerprint("mso_mdoc")).not.toBe(fingerprint("dc+sd-jwt"));
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
            // Like a registrar with custom_provides_attestations support, the
            // certificate lists the requested types.
            resolveRegistrationCertificate: vi.fn(
                async ({ body }: { body: Record<string, unknown> }) => ({
                    jwt: active,
                    payload: {
                        iat: 1,
                        exp: 2,
                        provides_attestations:
                            body.custom_provides_attestations,
                    },
                }),
            ),
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
            new IssuerRegistrationCertificateLock(),
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
                    provides_attestations: [],
                    custom_provides_attestations: [
                        {
                            format: "dc+sd-jwt",
                            meta: { vct_values: [" urn:padded "] },
                        },
                        {
                            format: "dc+sd-jwt",
                            meta: {
                                vct_values: [
                                    "https://issuer.example/issuers/t/credentials-metadata/vct/hosted",
                                ],
                            },
                        },
                        {
                            format: "mso_mdoc",
                            meta: { doctype_value: "org.iso.18013.5.1.mDL" },
                        },
                        {
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:eudi:pid:de:1"] },
                        },
                    ],
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

    it("keeps serving an outdated certificate in manual mode", async () => {
        const cached = jwt({ exp: now() + 60, id: "cached" });
        const { provider, registrar } = setup({
            jwt: cached,
            fingerprint: "outdated",
        });

        await expect(
            provider.resolve("t", { mode: "generate", renewal: "manual" }),
        ).resolves.toBe(cached);
        expect(registrar.resolveRegistrationCertificate).not.toHaveBeenCalled();
    });

    it("renews an expired certificate in manual mode", async () => {
        const { provider, registrar } = setup({
            jwt: expired,
            fingerprint: "outdated",
        });

        await expect(
            provider.resolve("t", { mode: "generate", renewal: "manual" }),
        ).resolves.toBe(active);
        expect(registrar.resolveRegistrationCertificate).toHaveBeenCalledOnce();
    });

    it("requests one certificate when a tenant resolves twice at once", async () => {
        const { provider, registrar, issuance } = setup(null);
        issuance.updateRegistrationCertificateCache.mockImplementation(
            async (_tenantId: string, cache: unknown) => {
                issuance.getIssuanceConfiguration.mockResolvedValue({
                    registrationCertificateCache: cache as never,
                });
            },
        );

        const settings = { mode: "generate" as const };
        await expect(
            Promise.all([
                provider.resolve("t", settings),
                provider.resolve("t", settings),
            ]),
        ).resolves.toEqual([active, active]);
        expect(registrar.resolveRegistrationCertificate).toHaveBeenCalledOnce();
    });

    it("shares a running request instead of queueing another one", async () => {
        const { provider, registrar } = setup(null);
        let finish!: () => void;
        registrar.resolveRegistrationCertificate.mockImplementationOnce(
            ({ body }: { body: Record<string, unknown> }) =>
                new Promise((resolve) => {
                    finish = () =>
                        resolve({
                            jwt: active,
                            payload: {
                                provides_attestations:
                                    body.custom_provides_attestations,
                            },
                        });
                }),
        );

        const settings = { mode: "generate" as const };
        const first = provider.resolve("t", settings);
        await vi.waitFor(() =>
            expect(registrar.resolveRegistrationCertificate).toHaveBeenCalled(),
        );
        // The cache is never updated here, so only sharing the running
        // request keeps the second caller from requesting its own.
        const second = provider.resolve("t", settings);
        finish();

        await expect(Promise.all([first, second])).resolves.toEqual([
            active,
            active,
        ]);
        expect(registrar.resolveRegistrationCertificate).toHaveBeenCalledOnce();
    });

    it("revokes and does not publish a certificate that does not list the requested types", async () => {
        const previous = jwt({ exp: now() + 60, id: "previous" });
        const { provider, registrar, issuance } = setup({
            jwt: previous,
            fingerprint: "outdated",
        });
        registrar.resolveRegistrationCertificate.mockResolvedValueOnce({
            jwt: active,
            payload: { provides_attestations: [] },
        });

        await expect(
            provider.resolve("t", { mode: "generate" }),
        ).resolves.toBeUndefined();
        expect(
            registrar.revokeRegistrationCertificateByJwt,
        ).toHaveBeenCalledExactlyOnceWith("t", active);
        expect(
            issuance.updateRegistrationCertificateCache,
        ).not.toHaveBeenCalled();
    });

    it("uses the stored settings when an older caller shares the run", async () => {
        const { provider, registrar, issuance } = setup(null);
        issuance.getIssuanceConfiguration.mockResolvedValue({
            registrationCertificate: {
                enabled: true,
                mode: "generate",
                privacyPolicy: "https://new",
            },
            registrationCertificateCache: null,
        } as never);

        await provider.resolve("t", {
            mode: "generate",
            privacyPolicy: "https://old",
        });
        expect(registrar.resolveRegistrationCertificate).toHaveBeenCalledWith(
            {
                body: expect.objectContaining({
                    privacy_policy: "https://new",
                }),
            },
            {},
            expect.any(String),
            "t",
        );
    });

    it("keeps a cached certificate in manual mode when no credential type is left", async () => {
        const cached = jwt({ exp: now() + 60, id: "cached" });
        const { provider, registrar } = setup(
            { jwt: cached, fingerprint: "outdated" },
            [],
        );

        await expect(
            provider.resolve("t", { mode: "generate", renewal: "manual" }),
        ).resolves.toBe(cached);
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
