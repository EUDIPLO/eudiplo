import { zCredentialIssuerMetadataSchema } from "@openid4vc/openid4vci";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoImplementationService } from "../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { CredentialsService } from "./credentials.service.js";
import {
    type CredentialConfig,
    CredentialFormat,
    CredentialProofType,
    type IssuerMetadataCredentialConfig,
} from "./entities/credential.entity.js";

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
