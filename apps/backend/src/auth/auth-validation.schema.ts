import Joi from "joi";
import { OIDC_DEFAULTS } from "./auth-settings.js";

export const AUTH_VALIDATION_SCHEMA: Joi.ObjectSchema = Joi.object({
    OIDC: Joi.string()
        .description(
            "Issuer URL of the identity provider, exactly as its discovery document names it, for example `https://keycloak.example.com/realms/eudiplo` or `https://auth.example.com/application/o/eudiplo/`. Setting it switches the management API to OIDC mode; `OIDC_PROVIDER` selects the provider",
        )
        .meta({ group: "auth", order: 10 }),

    OIDC_PROVIDER: Joi.string()
        .valid("keycloak", "generic")
        .when("OIDC", {
            is: Joi.exist(),
            then: Joi.string().default("keycloak"),
            // Without OIDC it would make settings of OIDC mode required.
            otherwise: Joi.forbidden().messages({
                "any.unknown": '"OIDC_PROVIDER" needs "OIDC"',
            }),
        })
        .description(
            "Identity provider in OIDC mode. `keycloak` manages clients and people through the Keycloak admin API. `generic` accepts access tokens of any OpenID Connect provider and leaves clients and people to that provider: the client and user endpoints answer `501`, and the Web Client offers no single sign-on yet",
        )
        .meta({
            group: "auth",
            order: 15,
            defaultText: "`keycloak` in OIDC mode",
        }),

    OIDC_AUDIENCE: Joi.string()
        .when("OIDC_PROVIDER", { is: "generic", then: Joi.required() })
        .description(
            "Value the `aud` claim of access tokens must contain. Required with `OIDC_PROVIDER=generic`, so that tokens the provider issues for other applications are refused; use an audience that only EUDIPLO's access tokens carry, such as an API identifier, not a client ID that ID tokens carry too. With Keycloak it is checked only when set; Keycloak access tokens carry `aud: account` unless an audience mapper adds this value, also for the clients EUDIPLO creates",
        )
        .meta({ group: "auth", order: 16 }),

    OIDC_ROLES_CLAIM: Joi.string()
        .description(
            "Claim with the EUDIPLO roles in OIDC mode: a claim name, or a dot path into nested claims such as `resource_access.eudiplo.roles`. A claim with exactly this name wins over a path, so namespaced names such as `https://eudiplo.example.com/roles` work. The claim holds an array of role names or an object whose keys are role names (Zitadel, which ignores the organizations in its values, so request tokens for one organization). Without it, the roles come from `roles` or `realm_access.roles`. With Keycloak, the clients EUDIPLO creates carry only these two claims",
        )
        .meta({ group: "auth", order: 17 }),

    OIDC_JWKS_URI: Joi.string()
        .uri()
        .description(
            "URL of the signing keys with `OIDC_PROVIDER=generic`, instead of `jwks_uri` of the discovery document, for example when the backend reaches the provider under another host name",
        )
        .meta({ group: "auth", order: 18 }),

    OIDC_INTERNAL_ISSUER_URL: Joi.string()
        .uri()
        .when("OIDC", {
            is: Joi.exist(),
            then: Joi.string().default((config) => config.OIDC),
            otherwise: Joi.optional(),
        })
        .description(
            "With Keycloak, the issuer that access tokens must carry and the base URL of the realm's signing keys. With `OIDC_PROVIDER=generic`, the URL from which the backend loads the discovery document when it reaches the provider under another address than `OIDC`, for example `http://authentik:9000/application/o/eudiplo/` in Docker Compose; tokens must carry `OIDC`",
        )
        .meta({ group: "auth", order: 20, defaultText: "the value of `OIDC`" }),

    // OIDC_PROVIDER defaults to keycloak only when OIDC is set.
    OIDC_CLIENT_ID: Joi.when("OIDC_PROVIDER", {
        is: "keycloak",
        then: Joi.string().required(),
        otherwise: Joi.optional(),
    })
        .description(
            "Client ID with which EUDIPLO uses the Keycloak admin API. Required with `OIDC_PROVIDER=keycloak`, unused with `generic`",
        )
        .meta({ group: "auth", order: 25 }),

    OIDC_CLIENT_SECRET: Joi.when("OIDC_PROVIDER", {
        is: "keycloak",
        then: Joi.string().required(),
        otherwise: Joi.optional(),
    })
        .description(
            "Client secret of `OIDC_CLIENT_ID`. Required with `OIDC_PROVIDER=keycloak`, unused with `generic`",
        )
        .meta({ group: "auth", order: 26 }),

    OIDC_SUB: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().default(OIDC_DEFAULTS.tenantClaim),
        otherwise: Joi.optional(),
    })
        .description("Claim with the tenant ID of access tokens in OIDC mode")
        .meta({ group: "auth", order: 30 }),

    OIDC_ALGORITHM: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string()
            .valid("RS256", "PS256", "ES256")
            .default(OIDC_DEFAULTS.algorithm),
        otherwise: Joi.optional(),
    })
        .description("Expected JWT alg")
        .meta({ group: "auth", order: 40 }),

    MASTER_SECRET: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().min(32).required(),
    })
        .description(
            "Master secret for JWT signing and encryption key derivation - required, minimum 32 characters",
        )
        .meta({ group: "auth", order: 50 }),

    JWT_ISSUER: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().default("eudiplo-service"),
    })
        .description("Local JWT issuer")
        .meta({ group: "auth", order: 60 }),

    AUTH_CLIENT_SECRET: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().required(),
    })
        .description(
            "Client secret (local auth). With `OIDC_PROVIDER=keycloak`, optional bootstrap secret used to create/update a Keycloak admin/root client when AUTH_CLIENT_ID is also set; unused with `generic`",
        )
        .meta({ group: "auth", order: 80 }),

    AUTH_CLIENT_ID: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().required(),
    })
        .description(
            "Client ID (local auth). With `OIDC_PROVIDER=keycloak`, optional bootstrap client ID used to create/update a Keycloak admin/root client when AUTH_CLIENT_SECRET is also set; unused with `generic`",
        )
        .meta({ group: "auth", order: 90 }),

    OIDC_UI_CLIENT_ID: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().default(OIDC_DEFAULTS.uiClientId),
        otherwise: Joi.optional(),
    })
        .description(
            "Public client ID for the Angular UI with `OIDC_PROVIDER=keycloak`. Used to register a public Keycloak client for Authorization Code + PKCE login.",
        )
        .meta({ group: "auth", order: 95 }),
}).unknown(true);
