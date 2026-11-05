import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PassportModule } from "@nestjs/passport";
import { OutboundUrlPolicyModule } from "../webhook/outbound-url-policy.module.js";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { OidcIssuerMetadataLoader } from "./adapters/oidc-issuer-metadata.loader.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import {
    AUTH_SETTINGS,
    type AuthSettings,
    readAuthSettings,
} from "./auth-settings.js";
import { ClientModule } from "./client/client.module.js";
import { JwtService } from "./jwt.service.js";
import { JwtStrategy } from "./jwt.strategy.js";
import {
    OIDC_ISSUER_METADATA,
    type OidcIssuerMetadata,
} from "./ports/oidc-issuer-metadata.js";
import { TenantModule } from "./tenant/tenant.module.js";
import { UserModule } from "./user/user.module.js";
@Module({
    imports: [
        PassportModule,
        ConfigModule,
        OutboundUrlPolicyModule,
        TenantModule,
        ClientModule,
        UserModule,
    ],
    providers: [
        {
            provide: AUTH_SETTINGS,
            inject: [ConfigService],
            useFactory: readAuthSettings,
        },
        {
            // Loaded before JwtStrategy, whose constructor needs the issuer and keys.
            provide: OIDC_ISSUER_METADATA,
            inject: [AUTH_SETTINGS, OutboundUrlPolicyService],
            useFactory: (
                settings: AuthSettings,
                outboundUrlPolicy: OutboundUrlPolicyService,
            ): Promise<OidcIssuerMetadata> | null =>
                settings.mode === "generic"
                    ? new OidcIssuerMetadataLoader(outboundUrlPolicy).load(
                          settings,
                      )
                    : null,
        },
        JwtStrategy,
        JwtService,
        AuthService,
    ],
    controllers: [AuthController],
    exports: [PassportModule, JwtStrategy, JwtService],
})
export class AuthModule {}
