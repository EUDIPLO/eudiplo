import type { ConfigService } from "@nestjs/config";

export const AUTH_SETTINGS = Symbol("AUTH_SETTINGS");

/** Defaults of OIDC mode, shared with the validation schema. */
export const OIDC_DEFAULTS = {
    tenantClaim: "tenant_id",
    algorithm: "RS256",
    uiClientId: "eudiplo-ui",
} as const;

/**
 * The OpenID Connect provider whose access tokens the management API accepts
 * instead of issuing its own (`OIDC`). With `keycloak`, EUDIPLO also manages
 * clients and people through the Keycloak admin API; with `generic`, the
 * provider manages them.
 */
export interface ExternalAuthSettings {
    mode: "keycloak" | "generic";
    /** Issuer the tokens carry (`OIDC`). */
    issuer: string;
    /** Issuer URL under which the backend reaches the provider (`OIDC_INTERNAL_ISSUER_URL`). */
    internalIssuer: string;
    /** Value the `aud` claim must contain (`OIDC_AUDIENCE`); checked when set. */
    audience?: string;
    /** Claim with the tenant ID (`OIDC_SUB`). */
    tenantClaim: string;
    /** Claim or dot path with the roles (`OIDC_ROLES_CLAIM`). */
    rolesClaim?: string;
    /** Key set that replaces the one of the discovery document (`OIDC_JWKS_URI`). */
    jwksUri?: string;
    /** Signature algorithm of the tokens (`OIDC_ALGORITHM`). */
    algorithm: string;
    /**
     * Public client of the Web Client (`OIDC_UI_CLIENT_ID`). Keycloak mode has
     * a default; with `generic`, single sign-on is offered only when it is set.
     */
    uiClientId?: string;
}

/** How the management API authenticates; `builtin` issues its own tokens. */
export type AuthSettings = { mode: "builtin" } | ExternalAuthSettings;

/** Reads the validated authentication settings once. */
export function readAuthSettings(configService: ConfigService): AuthSettings {
    const issuer = configService.get<string>("OIDC");
    if (issuer === undefined) {
        return { mode: "builtin" };
    }
    const mode =
        configService.get<string>("OIDC_PROVIDER") === "generic"
            ? "generic"
            : "keycloak";
    const uiClientId = configService.get<string>("OIDC_UI_CLIENT_ID");
    return {
        mode,
        issuer,
        internalIssuer:
            configService.get<string>("OIDC_INTERNAL_ISSUER_URL") ?? issuer,
        audience: configService.get<string>("OIDC_AUDIENCE"),
        tenantClaim:
            configService.get<string>("OIDC_SUB") ?? OIDC_DEFAULTS.tenantClaim,
        rolesClaim: configService.get<string>("OIDC_ROLES_CLAIM"),
        jwksUri: configService.get<string>("OIDC_JWKS_URI"),
        algorithm:
            configService.get<string>("OIDC_ALGORITHM") ??
            OIDC_DEFAULTS.algorithm,
        uiClientId:
            mode === "generic"
                ? uiClientId
                : (uiClientId ?? OIDC_DEFAULTS.uiClientId),
    };
}
