import type { ConfigService } from "@nestjs/config";
import type { Jwk } from "@openid4vc/oauth2";
import { zCredentialIssuerMetadataSchema } from "@openid4vc/openid4vci";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoImplementationService } from "../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import type { Session } from "../../../session/entities/session.entity.js";
import { CredentialsService } from "./credentials.service.js";
import {
    type CredentialConfig,
    CredentialFormat,
    CredentialProofType,
    type IssuerMetadataCredentialConfig,
} from "./entities/credential.entity.js";
import { InvalidClaimsException } from "./exceptions/invalid-claims.exception.js";

const SIGNING_ALGS = ["ES256"];

type ProofTypesSupported = Record<string, Record<string, unknown>>;

describe("CredentialsService proof_types_supported generation", () => {
    let service: CredentialsService;
    let findBy: ReturnType<typeof vi.fn>;

    const buildEntity = (
        config: Partial<IssuerMetadataCredentialConfig>,
        overrides: Partial<CredentialConfig> = {},
    ): CredentialConfig =>
        ({
            id: "credential-1",
            tenantId: "tenant-1",
            fields: [],
            vct: "https://issuer.example/vct/credential-1",
            config: {
                format: CredentialFormat.SD_JWT_VC,
                display: [],
                ...config,
            },
            ...overrides,
        }) as unknown as CredentialConfig;

    const getProofTypes = async (
        entity: CredentialConfig,
    ): Promise<ProofTypesSupported> => {
        findBy.mockResolvedValue([entity]);
        const supported =
            await service.getCredentialConfigurationSupported("tenant-1");
        return (supported[entity.id] as unknown as Record<string, unknown>)
            .proof_types_supported as ProofTypesSupported;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        findBy = vi.fn();

        service = Object.assign(
            Object.create(CredentialsService.prototype) as CredentialsService,
            {
                credentialConfigRepo: { findBy },
                configService: {
                    getOrThrow: vi.fn(() => "https://issuer.example"),
                } as unknown as ConfigService,
                cryptoImplementationService: {
                    getAlgs: vi.fn(() => SIGNING_ALGS),
                } as unknown as CryptoImplementationService,
            },
        );
    });

    it("omits key_attestations_required for jwt-only configurations", async () => {
        const proofTypes = await getProofTypes(
            buildEntity({
                proofTypesSupported: [CredentialProofType.JWT],
            }),
        );

        expect(Object.keys(proofTypes)).toEqual(["jwt"]);
        expect(proofTypes.jwt).not.toHaveProperty("key_attestations_required");
    });

    it("keeps configured keyAttestationsRequired for jwt-only configurations", async () => {
        const proofTypes = await getProofTypes(
            buildEntity({
                proofTypesSupported: [CredentialProofType.JWT],
                keyAttestationsRequired: {
                    key_storage: ["iso_18045_high"],
                },
            }),
        );

        expect(proofTypes.jwt.key_attestations_required).toEqual({
            key_storage: ["iso_18045_high"],
        });
    });

    it("omits key_attestations_required for attestation without constraints", async () => {
        const proofTypes = await getProofTypes(
            buildEntity({
                proofTypesSupported: [
                    CredentialProofType.ATTESTATION,
                    CredentialProofType.JWT,
                ],
            }),
        );

        expect(proofTypes.attestation).not.toHaveProperty(
            "key_attestations_required",
        );
        expect(proofTypes.jwt).not.toHaveProperty("key_attestations_required");
    });

    it("applies configured constraints to both proof types", async () => {
        const keyAttestationsRequired = {
            key_storage: ["iso_18045_high"],
            user_authentication: ["iso_18045_moderate"],
        };

        const proofTypes = await getProofTypes(
            buildEntity({
                proofTypesSupported: [
                    CredentialProofType.ATTESTATION,
                    CredentialProofType.JWT,
                ],
                keyAttestationsRequired,
            }),
        );

        expect(proofTypes.attestation.key_attestations_required).toEqual(
            keyAttestationsRequired,
        );
        expect(proofTypes.jwt.key_attestations_required).toEqual(
            keyAttestationsRequired,
        );
    });

    it("omits key_attestations_required for unconstrained attestation proofs", async () => {
        const entities = [
            buildEntity({}),
            buildEntity({
                proofTypesSupported: [CredentialProofType.ATTESTATION],
            }),
            buildEntity({
                format: CredentialFormat.MSO_MDOC,
                docType: "org.iso.18013.5.1.mDL",
                proofTypesSupported: [
                    CredentialProofType.ATTESTATION,
                    CredentialProofType.JWT,
                ],
            }),
        ];

        for (const entity of entities) {
            const proofTypes = await getProofTypes(entity);
            expect(proofTypes.attestation).toBeDefined();
            expect(proofTypes.attestation).not.toHaveProperty(
                "key_attestations_required",
            );
        }
    });

    it("produces issuer metadata that the OpenID4VCI parser accepts", async () => {
        findBy.mockResolvedValue([
            buildEntity({
                keyAttestationsRequired: {
                    key_storage: ["iso_18045_high"],
                },
            }),
        ]);

        const credentialConfigurationsSupported =
            await service.getCredentialConfigurationSupported("tenant-1");

        const metadata = {
            credential_issuer: "https://issuer.example/issuers/tenant-1",
            credential_endpoint:
                "https://issuer.example/issuers/tenant-1/vci/credential",
            credential_configurations_supported:
                credentialConfigurationsSupported,
        };

        const parsed = zCredentialIssuerMetadataSchema.safeParse(metadata);
        expect(parsed.success).toBe(true);

        const parsedProofTypes = (
            parsed.data?.credential_configurations_supported[
                "credential-1"
            ] as unknown as Record<string, unknown>
        ).proof_types_supported as ProofTypesSupported;
        expect(parsedProofTypes.attestation.key_attestations_required).toEqual({
            key_storage: ["iso_18045_high"],
        });
    });
});

describe("CredentialsService claim validation before signing", () => {
    let service: CredentialsService;
    let issue: ReturnType<typeof vi.fn>;
    let sendWebhook: ReturnType<typeof vi.fn>;
    let findAttributeProvider: ReturnType<typeof vi.fn>;

    const credentialConfig = {
        id: "citizen",
        tenantId: "tenant-1",
        fields: [
            {
                path: ["town"],
                type: "string",
                mandatory: true,
                defaultValue: "BERLIN",
            },
            {
                path: ["address"],
                type: "object",
                children: [
                    { path: ["street"], type: "string", mandatory: true },
                ],
            },
        ],
        config: { format: CredentialFormat.SD_JWT_VC },
    } as unknown as CredentialConfig;

    const sessionWith = (credentialClaims?: Record<string, unknown>) =>
        ({
            id: "session-1",
            tenantId: "tenant-1",
            credentialPayload: credentialClaims ? { credentialClaims } : {},
        }) as unknown as Session;

    const getCredential = (
        session: Session,
        preloadedClaims?: Record<string, any>,
    ) => service.getCredential("citizen", {} as Jwk, session, preloadedClaims);

    beforeEach(() => {
        vi.clearAllMocks();
        issue = vi.fn().mockResolvedValue("credential");
        sendWebhook = vi.fn();
        findAttributeProvider = vi.fn();

        service = Object.assign(
            Object.create(CredentialsService.prototype) as CredentialsService,
            {
                credentialConfigRepo: {
                    findOneByOrFail: vi
                        .fn()
                        .mockResolvedValue(credentialConfig),
                },
                attributeProviderRepo: { findOneBy: findAttributeProvider },
                webhookService: { sendWebhook },
                sdjwtvcIssuerService: { issue },
                issuanceService: {
                    getIssuanceConfiguration: vi
                        .fn()
                        .mockRejectedValue(new Error("none")),
                },
            },
        );
    });

    it("issues statically configured claims that match the configuration", async () => {
        await expect(getCredential(sessionWith())).resolves.toBe("credential");
        expect(issue).toHaveBeenCalledWith(
            expect.objectContaining({ claims: { town: "BERLIN" } }),
        );
    });

    it("issues preloaded claims that match the configuration", async () => {
        await getCredential(sessionWith(), {
            town: "Köln",
            address: { street: "Main St" },
        });
        expect(issue).toHaveBeenCalledOnce();
    });

    it("rejects inline claims with a wrong type before signing", async () => {
        await expect(
            getCredential(
                sessionWith({
                    citizen: { type: "inline", claims: { town: 5 } },
                }),
            ),
        ).rejects.toThrow(InvalidClaimsException);
        expect(issue).not.toHaveBeenCalled();
    });

    it("rejects webhook claims with an unexpected claim before signing", async () => {
        sendWebhook.mockResolvedValue({
            citizen: { town: "Köln", nickname: "x" },
        });

        await expect(
            getCredential(
                sessionWith({
                    citizen: {
                        type: "webhook",
                        webhook: { url: "https://hook.example" },
                    },
                }),
            ),
        ).rejects.toThrow("/nickname: unexpected claim");
        expect(issue).not.toHaveBeenCalled();
    });

    it("rejects attribute provider claims with a missing required claim", async () => {
        const configWithProvider = {
            ...credentialConfig,
            attributeProviderId: "ap-1",
        };
        Object.assign(service, {
            credentialConfigRepo: {
                findOneByOrFail: vi.fn().mockResolvedValue(configWithProvider),
            },
        });
        findAttributeProvider.mockResolvedValue({ url: "https://ap.example" });
        sendWebhook.mockResolvedValue({
            citizen: { address: { street: "Main St" } },
        });

        await expect(getCredential(sessionWith())).rejects.toThrow(
            "/town: missing required claim",
        );
        expect(issue).not.toHaveBeenCalled();
    });

    it("rejects invalid nested claims", async () => {
        await expect(
            getCredential(sessionWith(), {
                town: "Köln",
                address: { street: 1 },
            }),
        ).rejects.toThrow("/address/street: must be string");
    });

    it("names the affected claim paths without exposing claim values", async () => {
        const error = await getCredential(sessionWith(), {
            town: "SECRET-TOWN",
            ssn: "123-45-6789",
            address: { street: 42 },
        }).catch((e: Error) => e);

        expect(error).toBeInstanceOf(InvalidClaimsException);
        expect((error as Error).message).toContain("/ssn: unexpected claim");
        expect((error as Error).message).not.toContain("123-45-6789");
        expect((error as Error).message).not.toContain("SECRET-TOWN");
    });

    it("does not validate configurations without fields", async () => {
        Object.assign(service, {
            credentialConfigRepo: {
                findOneByOrFail: vi
                    .fn()
                    .mockResolvedValue({ ...credentialConfig, fields: [] }),
            },
        });

        await expect(
            getCredential(sessionWith(), { anything: true }),
        ).resolves.toBe("credential");
    });
});
