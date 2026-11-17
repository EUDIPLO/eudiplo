import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import {
    AuthorizationRequestSchema,
    PushedAuthorizationRequestSchema,
    SignInCallbackQuerySchema,
    TokenRequestSchema,
} from "../schemas/oidc-protocol.schema.js";

export class OidcAuthorizationRequestDto extends createZodDto(
    AuthorizationRequestSchema,
) {}

export class OidcPushedAuthorizationRequestDto extends createZodDto(
    PushedAuthorizationRequestSchema,
) {}

export class OidcTokenRequestDto extends createZodDto(TokenRequestSchema) {}

export class OidcSignInCallbackQueryDto extends createZodDto(
    SignInCallbackQuerySchema,
) {}

export class OidcPushedAuthorizationResponseDto {
    @ApiProperty()
    request_uri!: string;

    @ApiProperty()
    expires_in!: number;
}

export class OidcTokenResponseDto {
    @ApiProperty({ description: "Opaque; no endpoint accepts it" })
    access_token!: string;

    @ApiProperty({ enum: ["Bearer"] })
    token_type!: "Bearer";

    @ApiProperty()
    expires_in!: number;

    @ApiProperty({
        description:
            "Signed ID token with the verified claims under `credentials`",
    })
    id_token!: string;

    @ApiProperty()
    scope!: string;
}

export class OidcErrorResponseDto {
    @ApiProperty()
    error!: string;

    @ApiPropertyOptional()
    error_description?: string;
}

export class OidcSignInStatusDto {
    @ApiProperty({
        enum: ["waiting", "ready"],
        description: "`ready`: continue to the completion endpoint",
    })
    state!: "waiting" | "ready";
}
