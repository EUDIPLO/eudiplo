import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { decodeProtectedHeader } from "jose";
import { passportJwtSecret } from "jwks-rsa";
import { ExtractJwt, Strategy } from "passport-jwt";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { jwksFetcher } from "./adapters/jwks-fetcher.js";
import {
    AUTH_SETTINGS,
    type AuthSettings,
    type ExternalAuthSettings,
} from "./auth-settings.js";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client/client.provider.js";
import type { ClientData } from "./client/domain/client-data.js";
import {
    accessTokenTypeRefusal,
    idTokenClaimRefusal,
    keycloakTokenTypeRefusal,
} from "./domain/access-token-shape.js";
import { claimValue, roleNames } from "./domain/token-claims.js";
import { ACCESS_TOKEN_LIFETIME_SECONDS } from "./jwt.service.js";
import {
    OIDC_ISSUER_METADATA,
    type OidcIssuerMetadata,
} from "./ports/oidc-issuer-metadata.js";
import type { Role } from "./roles/role.enum.js";
import { TenantNotFound } from "./tenant/domain/tenant-data.js";
import { TenantService } from "./tenant/tenant.service.js";
import { InternalTokenPayload, TokenPayload } from "./token.decorator.js";

/** What the signature check of an external token compares. */
export interface ExternalTokenChecks {
    issuer: string;
    jwksUri: string;
    /** Checked only when set. */
    audience?: string;
    algorithms: string[];
    /** Origins the operator configured, which skip the outbound URL policy. */
    trustedOrigins: string[];
}

/**
 * Keycloak: the realm's issuer and keys under the internal issuer URL. Other
 * providers: the issuer and keys of the discovery document, which startup
 * loaded, or `OIDC_JWKS_URI`. The audience is required for other providers
 * and checked for Keycloak when it is set.
 */
export function externalTokenChecks(
    settings: ExternalAuthSettings,
    issuerMetadata: OidcIssuerMetadata | null,
): ExternalTokenChecks {
    const algorithms = [settings.algorithm];
    const trustedOrigins = [
        ...new Set(
            [settings.issuer, settings.internalIssuer, settings.jwksUri]
                .filter((url) => url !== undefined)
                .map((url) => new URL(url).origin),
        ),
    ];
    if (settings.mode === "keycloak") {
        return {
            issuer: settings.internalIssuer,
            jwksUri: `${settings.internalIssuer}/protocol/openid-connect/certs`,
            audience: settings.audience,
            algorithms,
            trustedOrigins,
        };
    }
    if (!issuerMetadata) {
        throw new Error(
            "The OIDC discovery document was not loaded for OIDC_PROVIDER=generic",
        );
    }
    return {
        issuer: issuerMetadata.issuer,
        jwksUri: settings.jwksUri ?? issuerMetadata.jwks_uri,
        audience: settings.audience,
        algorithms,
        trustedOrigins,
    };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
    /** The external provider, or undefined for the built-in server. */
    private readonly external?: ExternalAuthSettings;

    constructor(
        configService: ConfigService,
        private readonly tenantService: TenantService,
        @Inject(CLIENTS_PROVIDER)
        private readonly clientsProvider: ClientsProvider,
        @Inject(AUTH_SETTINGS) settings: AuthSettings,
        @Inject(OIDC_ISSUER_METADATA)
        issuerMetadata: OidcIssuerMetadata | null,
        outboundUrlPolicy: OutboundUrlPolicyService,
    ) {
        super(
            settings.mode === "builtin"
                ? JwtStrategy.getIntegratedOAuth2Config(configService)
                : JwtStrategy.getExternalOIDCConfig(
                      externalTokenChecks(settings, issuerMetadata),
                      outboundUrlPolicy,
                  ),
        );
        if (settings.mode !== "builtin") {
            this.external = settings;
        }
    }

    // Override authenticate to add debugging
    authenticate(req: any, options?: any) {
        return super.authenticate(req, {
            ...options,
            failWithError: true, // This will throw errors instead of just returning 401
        });
    }

    private static getExternalOIDCConfig(
        checks: ExternalTokenChecks,
        outboundUrlPolicy: OutboundUrlPolicyService,
    ) {
        const keyProvider = passportJwtSecret({
            cache: true,
            rateLimit: true,
            jwksRequestsPerMinute: 5,
            jwksUri: checks.jwksUri,
            fetcher: jwksFetcher(outboundUrlPolicy, checks.trustedOrigins),
            handleSigningKeyError: (err, cb) => {
                console.error("❌ JWKS error of the identity provider:", err);
                if (err instanceof Error) {
                    return cb(err);
                }
                return cb(
                    new Error(
                        "Could not get the signing key from the identity provider",
                    ),
                );
            },
        });
        return {
            secretOrKeyProvider:
                JwtStrategy.refusingOtherTokenTypes(keyProvider),
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            algorithms: checks.algorithms,
            issuer: checks.issuer,
            ...(checks.audience && { audience: checks.audience }),
        };
    }

    /**
     * Refuses a token whose JWS header names another type than an access
     * token before its key is looked up, so that ID, logout and other tokens
     * of the provider fail even when they carry the audience. The guard
     * answers with the reason.
     */
    private static refusingOtherTokenTypes(
        keyProvider: ReturnType<typeof passportJwtSecret>,
    ): ReturnType<typeof passportJwtSecret> {
        return (request, rawJwtToken, done) => {
            let header: { typ?: unknown } | undefined;
            try {
                header = decodeProtectedHeader(rawJwtToken as string);
            } catch {
                // Malformed tokens fail in the signature check, as before.
            }
            const refusal = header && accessTokenTypeRefusal(header);
            if (refusal) {
                return done(new UnauthorizedException(refusal));
            }
            return keyProvider(request, rawJwtToken, done);
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
        return this.external
            ? this.validateExternalToken(payload, this.external)
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
     * Tokens of the identity provider are checked without asking it. People
     * sign in through the web client's public client and the bootstrap client
     * has no record here, so a token whose client is unknown keeps the roles
     * of its claims and gets no resource limits. With `OIDC_PROVIDER=generic`
     * only records left from an earlier mode exist, matched by `azp`,
     * `client_id` or `sub`. Deleting a client removes it from Keycloak,
     * which issues no new tokens to it; tokens it already has stay valid
     * until they expire.
     */
    private async validateExternalToken(
        payload: InternalTokenPayload,
        settings: ExternalAuthSettings,
    ): Promise<TokenPayload> {
        // The signature check accepts tokens without exp, which never expire.
        if (typeof payload.exp !== "number") {
            throw new UnauthorizedException("Access token has no expiry");
        }
        // ID tokens are signed with the same keys; without OIDC_AUDIENCE,
        // Keycloak's for any client of the realm pass the signature check.
        const refusal =
            idTokenClaimRefusal(payload) ??
            (settings.mode === "keycloak"
                ? keycloakTokenTypeRefusal(payload)
                : undefined);
        if (refusal) {
            throw new UnauthorizedException(refusal);
        }
        const tenantId = (payload as any)[settings.tenantClaim] as
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
            roles: JwtStrategy.externalRoles(payload, settings.rolesClaim),
            client: client ?? undefined,
            subject,
            authorizedParty,
        };
    }

    /**
     * The roles of an external token: from `OIDC_ROLES_CLAIM`, or else from
     * `roles` or Keycloak's `realm_access.roles`.
     */
    private static externalRoles(
        payload: InternalTokenPayload,
        rolesClaim: string | undefined,
    ): Role[] {
        // Only arrays of strings count: String#includes would match parts of a string claim.
        const claim = rolesClaim
            ? claimValue(payload, rolesClaim)
            : payload.roles || (payload as any).realm_access?.roles;
        return roleNames(claim) as Role[];
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
     * The tenant an external token names, or `undefined` when there is none;
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
