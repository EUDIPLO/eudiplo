import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const IssuerRegistrationCertificateConfigSchema = z
    .object({
        enabled: z.boolean().optional(),
        jwt: z.string().optional(),
        privacyPolicy: z.string().optional(),
        supportUri: z.string().optional(),
    })
    .strict();

export class IssuerRegistrationCertificateConfig extends createZodDto(
    IssuerRegistrationCertificateConfigSchema,
) {
    @ApiPropertyOptional({
        description:
            "Enable inclusion of a registration certificate in credential issuer metadata.",
        default: false,
    })
    enabled?: boolean;

    @ApiPropertyOptional({
        description:
            "Registration certificate JWT advertised in the issuer metadata while it is valid, issued by a registrar such as the EUDI Hub.",
    })
    jwt?: string;

    @ApiPropertyOptional({
        description:
            "Privacy policy URL of the issuer. Stored only; EUDIPLO and the EUDI Hub request do not use it.",
        example: "https://issuer.example/privacy",
    })
    privacyPolicy?: string;

    @ApiPropertyOptional({
        description:
            "Support URI of the issuer. Kept with the certificate so that a new one can be requested from a registrar with the same values.",
        example: "https://issuer.example/support",
    })
    supportUri?: string;
}
