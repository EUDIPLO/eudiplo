import { Module, type Provider } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PassportModule } from "@nestjs/passport";
import { OutboundUrlPolicyModule } from "../webhook/outbound-url-policy.module.js";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { OidcIssuerMetadataLoader } from "./adapters/oidc-issuer-metadata.loader.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AUTH_SETTINGS, type AuthSettings } from "./auth-settings.js";
import { AuthSettingsModule } from "./auth-settings.module.js";
import { ClientModule } from "./client/client.module.js";
import { JwtService } from "./jwt.service.js";
import { JwtStrategy } from "./jwt.strategy.js";
import {
    OIDC_ISSUER_METADATA,
    type OidcIssuerMetadata,
} from "./ports/oidc-issuer-metadata.js";
import { TenantModule } from "./tenant/tenant.module.js";
import { UserModule } from "./user/user.module.js";

/**
 * The discovery document of another OpenID Connect provider, loaded before
 * JwtStrategy, whose constructor needs the issuer and keys. Keycloak and the
 * built-in server need none.
 */
export const oidcIssuerMetadataProvider: Provider = {
    provide: OIDC_ISSUER_METADATA,
    inject: [AUTH_SETTINGS, OutboundUrlPolicyService],
    useFactory: (
        settings: AuthSettings,
        outboundUrlPolicy: OutboundUrlPolicyService,
    ): Promise<OidcIssuerMetadata> | null =>
        settings.mode === "generic"
            ? new OidcIssuerMetadataLoader(outboundUrlPolicy).load(settings)
            : null,
};

@Module({
    imports: [
        PassportModule,
        ConfigModule,
        AuthSettingsModule,
        OutboundUrlPolicyModule,
        TenantModule,
        ClientModule,
        UserModule,
    ],
    providers: [
        oidcIssuerMetadataProvider,
        JwtStrategy,
        JwtService,
        AuthService,
    ],
    controllers: [AuthController],
    exports: [PassportModule, JwtStrategy, JwtService],
})
export class AuthModule {}
