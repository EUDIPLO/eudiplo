import {
    TRUST_LIST_COUNTRY_DESCRIPTION,
    TRUST_LIST_COUNTRY_PATTERN,
    TRUST_LIST_EMAIL_DESCRIPTION,
    TRUST_LIST_EMAIL_PATTERN,
    TRUST_LIST_LANGUAGE_DESCRIPTION,
    TRUST_LIST_LANGUAGE_TAG_PATTERN,
    TRUST_LIST_PHONE_DESCRIPTION,
    TRUST_LIST_PHONE_PATTERN,
    TRUST_LIST_URI_DESCRIPTION,
    TRUST_LIST_WEBSITE_DESCRIPTION,
    TRUST_LIST_WEBSITE_PATTERN,
} from "@eudiplo/config-format/trust-list-entity-info.js";
import {
    ApiExtraModels,
    ApiProperty,
    getSchemaPath,
    OmitType,
} from "@nestjs/swagger";
import { TrustList } from "../entities/trust-list.entity.js";

/**
 * Entity information for certificates (metadata for TEInformation)
 */
export class TrustListEntityInfo {
    name!: string;

    @ApiProperty({
        required: false,
        pattern: TRUST_LIST_LANGUAGE_TAG_PATTERN,
        description: TRUST_LIST_LANGUAGE_DESCRIPTION,
    })
    lang?: string;

    @ApiProperty({
        required: false,
        format: "uri",
        description: TRUST_LIST_URI_DESCRIPTION,
    })
    uri?: string;

    @ApiProperty({
        required: false,
        pattern: TRUST_LIST_COUNTRY_PATTERN,
        description: TRUST_LIST_COUNTRY_DESCRIPTION,
    })
    country?: string;

    locality?: string;

    postalCode?: string;

    streetAddress?: string;

    @ApiProperty({
        pattern: TRUST_LIST_EMAIL_PATTERN,
        description: TRUST_LIST_EMAIL_DESCRIPTION,
    })
    contactUri!: string;

    @ApiProperty({
        format: "uri",
        pattern: TRUST_LIST_WEBSITE_PATTERN,
        description: TRUST_LIST_WEBSITE_DESCRIPTION,
    })
    website!: string;

    @ApiProperty({
        required: false,
        pattern: TRUST_LIST_PHONE_PATTERN,
        description: TRUST_LIST_PHONE_DESCRIPTION,
    })
    phone?: string;
}

/**
 * Internal trust list entity - references certificates already in the system
 */
class InternalTrustListEntity {
    @ApiProperty({ enum: ["internal"] })
    type!: "internal";

    issuerKeyChainId!: string;

    revocationKeyChainId!: string;

    @ApiProperty({
        enum: ["attestation-provider", "wallet-provider"],
        required: false,
        default: "attestation-provider",
        description: "Provider role published in the trust list.",
    })
    providerType?: "attestation-provider" | "wallet-provider";

    info!: TrustListEntityInfo;
}

/**
 * External trust list entity - uses PEM certificates directly
 */
class ExternalTrustListEntity {
    @ApiProperty({ enum: ["external"] })
    type!: "external";

    issuerCertPem!: string;

    revocationCertPem!: string;

    @ApiProperty({
        enum: ["attestation-provider", "wallet-provider"],
        required: false,
        default: "attestation-provider",
        description: "Provider role published in the trust list.",
    })
    providerType?: "attestation-provider" | "wallet-provider";

    info!: TrustListEntityInfo;
}

export type TrustListEntity = InternalTrustListEntity | ExternalTrustListEntity;

/**
 * DTO for creating a new Trust List, omitting tenant-related and auto-generated fields.
 */
@ApiExtraModels(InternalTrustListEntity, ExternalTrustListEntity)
export class TrustListCreateDto extends OmitType(TrustList, [
    "tenant",
    "tenantId",
    "jwt",
    "keyChain",
    "keyChainId",
    "sequenceNumber",
    "createdAt",
    "updatedAt",
    "entityConfig",
    "id",
] as const) {
    id?: string;

    description?: string;

    keyChainId?: string;

    @ApiProperty({
        type: "array",
        items: {
            oneOf: [
                { $ref: getSchemaPath(InternalTrustListEntity) },
                { $ref: getSchemaPath(ExternalTrustListEntity) },
            ],
            discriminator: {
                propertyName: "type",
                mapping: {
                    internal: getSchemaPath(InternalTrustListEntity),
                    external: getSchemaPath(ExternalTrustListEntity),
                },
            },
        },
    })
    entities!: TrustListEntity[];
}
