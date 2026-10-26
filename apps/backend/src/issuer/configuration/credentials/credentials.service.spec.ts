import { UnsupportedClaimPattern } from "@eudiplo/config-format/claim-patterns.js";
import { NotFoundException } from "@nestjs/common";
import { zCredentialIssuerMetadataSchema } from "@openid4vc/openid4vci";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoImplementationService } from "../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import type { KeyChainService } from "../../../crypto/key/key-chain.service.js";
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
    let listForTenant: ReturnType<typeof vi.fn>;

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
        listForTenant.mockResolvedValue([entity]);
        const supported =
            await service.getCredentialConfigurationSupported("tenant-1");
        return (supported[entity.id] as unknown as Record<string, unknown>)
            .proof_types_supported as ProofTypesSupported;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        listForTenant = vi.fn();

        service = Object.assign(
            Object.create(CredentialsService.prototype) as CredentialsService,
            {
                credentialConfigurationRepository: {
                    listForTenant,
                    findForTenant: vi.fn(),
                    getForTenant: vi.fn(),
                    save: vi.fn(),
                    deleteForTenant: vi.fn(),
                },
                settings: { publicUrl: "https://issuer.example" },
                cryptoImplementationService: {
                    getAlgs: vi.fn(() => SIGNING_ALGS),
                    getSigningAlgs: vi.fn(() => SIGNING_ALGS),
                } as unknown as CryptoImplementationService,
                keyChainService: {
                    findByUsageType: vi.fn(async () => ({
                        activeJwk: { kty: "EC", crv: "P-256" },
                    })),
                } as unknown as KeyChainService,
            },
        );
    });

    const credentialAlgs = async (
        findByUsageType: ReturnType<typeof vi.fn>,
        config: Partial<IssuerMetadataCredentialConfig> = {},
    ) => {
        Object.assign(service, {
            cryptoImplementationService: new CryptoImplementationService(),
            keyChainService: { findByUsageType },
        });
        const entity = buildEntity({
            proofTypesSupported: [CredentialProofType.JWT],
            ...config,
        });
        listForTenant.mockResolvedValue([entity]);
        const supported = (await service.getCredentialConfigurationSupported(
            "tenant-1",
        )) as unknown as Record<string, Record<string, any>>;
        return {
            signing:
                supported[entity.id].credential_signing_alg_values_supported,
            proof: supported[entity.id].proof_types_supported.jwt
                .proof_signing_alg_values_supported,
        };
    };

    it("names the key chain's algorithm for the credential but accepts every proof algorithm", async () => {
        await expect(
            credentialAlgs(
                vi.fn().mockResolvedValue({
                    activeJwk: { kty: "EC", crv: "P-384" },
                }),
            ),
        ).resolves.toEqual({
            signing: ["ES384"],
            proof: ["ES256", "ES384", "ES512"],
        });
    });

    it("names only the COSE alg placed in the IssuerAuth header for mDOC", async () => {
        await expect(
            credentialAlgs(
                vi.fn().mockResolvedValue({
                    activeJwk: { kty: "EC", crv: "P-384" },
                }),
                {
                    format: CredentialFormat.MSO_MDOC,
                    docType: "org.iso.18013.5.1.mDL",
                },
            ),
        ).resolves.toMatchObject({ signing: [-35] });
    });

    it("falls back to ES256 without an attestation key chain and passes other errors on", async () => {
        await expect(
            credentialAlgs(
                vi.fn().mockRejectedValue(new NotFoundException("none")),
            ),
        ).resolves.toMatchObject({ signing: ["ES256"] });
        await expect(
            credentialAlgs(vi.fn().mockRejectedValue(new Error("db down"))),
        ).rejects.toThrow("db down");
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

    it("requires a key attestation without constraints for an empty requirement", async () => {
        const proofTypes = await getProofTypes(
            buildEntity({
                proofTypesSupported: [
                    CredentialProofType.ATTESTATION,
                    CredentialProofType.JWT,
                ],
                keyAttestationsRequired: {
                    key_storage: [],
                    user_authentication: ["iso_18045_high"],
                },
            }),
        );

        expect(proofTypes.jwt.key_attestations_required).toEqual({
            user_authentication: ["iso_18045_high"],
        });
        expect(proofTypes.attestation.key_attestations_required).toEqual({
            user_authentication: ["iso_18045_high"],
        });

        const unconstrained = await getProofTypes(
            buildEntity({
                proofTypesSupported: [CredentialProofType.JWT],
                keyAttestationsRequired: {},
            }),
        );
        expect(unconstrained.jwt.key_attestations_required).toEqual({});
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
        listForTenant.mockResolvedValue([
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

describe("CredentialsService.validateClaimsForCredential", () => {
    const serviceWith = (constraints: Record<string, unknown>) =>
        Object.assign(
            Object.create(CredentialsService.prototype) as CredentialsService,
            {
                credentialConfigurationRepository: {
                    getForTenant: vi.fn(async () => ({
                        id: "patterned",
                        fields: [
                            { path: ["name"], type: "string", constraints },
                        ],
                    })),
                },
            },
        );

    it("answers 409 for a stored pattern RE2 cannot run, without quoting it", async () => {
        const error = await serviceWith({ pattern: "^(?=secret)\\w+$" })
            .validateClaimsForCredential("patterned", { name: "x" }, "tenant")
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(InvalidClaimsException);
        expect(error).not.toBeInstanceOf(UnsupportedClaimPattern);
        expect((error as Error).message).toBe(
            "Credential configuration with id patterned has a claim pattern that cannot be used",
        );
    });

    it("answers 409 for claims that do not match the pattern", async () => {
        await expect(
            serviceWith({ pattern: "^[A-Z]+$" }).validateClaimsForCredential(
                "patterned",
                { name: "abc" },
                "tenant",
            ),
        ).rejects.toBeInstanceOf(InvalidClaimsException);
    });
});
