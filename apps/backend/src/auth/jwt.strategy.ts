import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { passportJwtSecret } from "jwks-rsa";
import { ExtractJwt, Strategy } from "passport-jwt";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client/client.provider.js";
import type { ClientData } from "./client/domain/client-data.js";
import { ACCESS_TOKEN_LIFETIME_SECONDS } from "./jwt.service.js";
import { TenantNotFound } from "./tenant/domain/tenant-data.js";
import { TenantService } from "./tenant/tenant.service.js";
import { InternalTokenPayload, TokenPayload } from "./token.decorator.js";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
    private readonly useExternalOIDC: boolean;
    /** Claim with the tenant ID of Keycloak tokens (`OIDC_SUB`). */
    private readonly tenantClaim?: string;

    constructor(
        configService: ConfigService,
        private readonly tenantService: TenantService,
        @Inject(CLIENTS_PROVIDER)
        private readonly clientsProvider: ClientsProvider,
    ) {
        const useExternalOIDC = configService.get<string>("OIDC") !== undefined;

        const config = useExternalOIDC
            ? JwtStrategy.getExternalOIDCConfig(configService)
            : JwtStrategy.getIntegratedOAuth2Config(configService);
        super(config);
        this.useExternalOIDC = useExternalOIDC;
        if (useExternalOIDC) {
            this.tenantClaim = configService.getOrThrow<string>("OIDC_SUB");
        }
    }

    // Override authenticate to add debugging
    authenticate(req: any, options?: any) {
        return super.authenticate(req, {
            ...options,
            failWithError: true, // This will throw errors instead of just returning 401
        });
    }

    private static getExternalOIDCConfig(configService: ConfigService) {
        const keycloakIssuerUrl = configService.get("OIDC_INTERNAL_ISSUER_URL");
        const audience = configService.get<string>("OIDC_AUDIENCE");
        const jwksUri = `${keycloakIssuerUrl}/protocol/openid-connect/certs`;

        return {
            secretOrKeyProvider: passportJwtSecret({
                cache: true,
                rateLimit: true,
                jwksRequestsPerMinute: 5,
                jwksUri: jwksUri,
                handleSigningKeyError: (err, cb) => {
                    console.error("❌ Keycloak JWKS error:", err);
                    if (err instanceof Error) {
                        return cb(err);
                    }
                    return cb(
                        new Error(
                            "Could not get the signing key from Keycloak",
                        ),
                    );
                },
            }),
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            algorithms: [configService.get("OIDC_ALGORITHM")],
            issuer: keycloakIssuerUrl,
            // Only tokens issued for EUDIPLO, when the operator names its
            // audience; other clients of the realm get other audiences.
            ...(audience && { audience }),
        };
    }

    private static getIntegratedOAuth2Config(
        configService: ConfigService,
    ): any {
        const config = {
            secretOrKey: configService.get("MASTER_SECRET"),
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            algorithms: ["HS256"], // Using symmetric key for integrated OAuth2
            ignoreExpiration: false, // Ensure tokens expire
        };

        // Add issuer validation only if JWT_ISSUER is configured
        const issuer = configService.get("JWT_ISSUER");
        if (issuer) {
            (config as any).issuer = issuer;
        }

        return config;
    }

    /**
     * Validate the JWT payload and resolve the tenant and the client.
     * @param payload The JWT payload
     * @returns The validated payload with tenant and client info
     */
    validate(payload: InternalTokenPayload): Promise<TokenPayload> {
        return this.useExternalOIDC
            ? this.validateExternalToken(payload)
            : this.validateIntegratedToken(payload);
    }

    /**
     * A token of the built-in server is accepted only while its client exists
     * in the tenant the token names. Roles and resource limits come from the
     * stored client, so deleting or changing a client applies to the tokens
     * it already has. Tokens issued for an earlier client with this ID or an
     * earlier secret are rejected. The client lookup is the one every request
     * already did.
     */
    private async validateIntegratedToken(
        payload: InternalTokenPayload,
    ): Promise<TokenPayload> {
        // Before 10.0 the token endpoint also returned a refresh token with
        // the same claims and a lifetime of 30 days. Its access tokens could
        // span a second more, as iat and exp were read from separate clocks.
        if (
            payload.iat === undefined ||
            payload.exp === undefined ||
            payload.exp - payload.iat > ACCESS_TOKEN_LIFETIME_SECONDS + 60
        ) {
            throw new UnauthorizedException("Not an access token");
        }
        const client = payload.sub
            ? await this.clientsProvider.getClientById(payload.sub)
            : null;
        if (!client) {
            throw new UnauthorizedException(
                "The client of this token does not exist",
            );
        }
        // The root client has no tenant: both are null for its tokens.
        JwtStrategy.assertSameTenant(client, payload.tenant_id);
        JwtStrategy.assertIssuedForCredentials(client, payload.credentials_at);
        // Clients go with their tenant, so it exists.
        const tenantEntity = client.tenantId
            ? await this.tenantService.getTenant(client.tenantId)
            : undefined;

        return {
            entity: tenantEntity,
            roles: client.roles,
            client,
            subject: payload.sub,
        };
    }

    /**
     * Keycloak tokens are checked without asking Keycloak. People sign in
     * through the web client's public client and the bootstrap client has no
     * record here, so a token whose client is unknown keeps the roles of its
     * claims and gets no resource limits. Deleting a client removes it from
     * Keycloak, which issues no new tokens to it; tokens it already has stay
     * valid until they expire.
     */
    private async validateExternalToken(
        payload: InternalTokenPayload,
    ): Promise<TokenPayload> {
        const tenantId = (payload as any)[this.tenantClaim!] as
            | string
            | undefined;

        const tenantEntity = await this.findTenant(tenantId);

        // Keycloak puts the client ID into azp (authorized party) or client_id.
        const subject = (payload as any).sub as string | undefined;
        const authorizedParty =
            ((payload as any).azp as string | undefined) ||
            ((payload as any).client_id as string | undefined);
        const clientId = authorizedParty || subject;
        // A failed lookup must not drop the client's limits.
        const client = clientId
            ? await this.clientsProvider.getClientById(clientId)
            : null;
        if (client) {
            JwtStrategy.assertSameTenant(client, tenantId);
        }

        return {
            entity: tenantEntity,
            roles: payload.roles || (payload as any).realm_access?.roles || [],
            client: client ?? undefined,
            subject,
            authorizedParty,
        };
    }

    /**
     * A client of another tenant than the token's: client IDs are unique, so
     * the token's own client was deleted and its ID reused.
     */
    private static assertSameTenant(
        client: ClientData,
        tenantId: string | null | undefined,
    ) {
        if ((client.tenantId ?? null) !== (tenantId ?? null)) {
            throw new UnauthorizedException(
                "The client of this token does not exist",
            );
        }
    }

    /**
     * A token naming other credentials than the client's current ones belongs
     * to an earlier client with this ID, or to an old secret. The token
     * endpoint reads them with the secret, so a change while a token is being
     * issued ends that token too; comparing with `iat` would not.
     */
    private static assertIssuedForCredentials(
        client: ClientData,
        credentialsAt: number | undefined,
    ) {
        const current = client.tokensValidAfter;
        if (current && credentialsAt !== current.getTime()) {
            throw new UnauthorizedException(
                "This token was issued for the client's earlier credentials",
            );
        }
    }

    /**
     * The tenant a Keycloak token names, or `undefined` when there is none;
     * other errors fail.
     */
    private async findTenant(tenantId: string | undefined) {
        if (!tenantId) {
            return undefined;
        }
        return this.tenantService.getTenant(tenantId).catch((error) => {
            if (error instanceof TenantNotFound) {
                return undefined;
            }
            throw error;
        });
    }
}
