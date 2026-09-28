import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * Discriminator for IAE action types.
 */
export const IaeActionType = {
    OPENID4VP_PRESENTATION: "openid4vp_presentation",

    REDIRECT_TO_WEB: "redirect_to_web",
} as const;
export type IaeActionType = (typeof IaeActionType)[keyof typeof IaeActionType];

const IaeActionOpenid4vpPresentationSchema = z
    .object({
        type: z.literal(IaeActionType.OPENID4VP_PRESENTATION),
        label: z.string().optional(),
        presentationConfigId: z.string(),
    })
    .strict();

const IaeActionRedirectToWebSchema = z
    .object({
        type: z.literal(IaeActionType.REDIRECT_TO_WEB),
        label: z.string().optional(),
        url: z.url(),
        callbackUrl: z.url().optional(),
        description: z.string().optional(),
    })
    .strict();

/**
 * IAE action for requesting a verifiable presentation via OpenID4VP.
 */
export class IaeActionOpenid4vpPresentation extends createZodDto(
    IaeActionOpenid4vpPresentationSchema,
) {
    @ApiProperty({
        description: "Action type discriminator",
        enum: [IaeActionType.OPENID4VP_PRESENTATION],
        example: IaeActionType.OPENID4VP_PRESENTATION,
    })
    declare type: typeof IaeActionType.OPENID4VP_PRESENTATION;

    @ApiProperty({
        description:
            "ID of the presentation configuration to use for this step",
        example: "pid-presentation-config",
    })
    presentationConfigId!: string;
}

/**
 * IAE action for redirecting to a web page.
 */
export class IaeActionRedirectToWeb extends createZodDto(
    IaeActionRedirectToWebSchema,
) {
    @ApiProperty({
        description: "Action type discriminator",
        enum: [IaeActionType.REDIRECT_TO_WEB],
        example: IaeActionType.REDIRECT_TO_WEB,
    })
    declare type: typeof IaeActionType.REDIRECT_TO_WEB;

    @ApiProperty({
        description: "URL to redirect the user to for web-based interaction",
        example: "https://example.com/verify?session={auth_session}",
    })
    url!: string;

    @ApiPropertyOptional({
        description:
            "URL where the external service should redirect back after completion. " +
            "If not provided, the service must call back to the IAE endpoint.",
        example:
            "https://issuer.example.com/{tenantId}/authorize/interactive/callback",
    })
    callbackUrl?: string;

    @ApiPropertyOptional({
        description:
            "Description of what the user should do on the web page (for wallet display)",
        example: "Please complete the identity verification form",
    })
    description?: string;
}

/**
 * Union type for all IAE actions.
 * This is a discriminated union based on the `type` field.
 */
export type IaeAction = IaeActionOpenid4vpPresentation | IaeActionRedirectToWeb;
