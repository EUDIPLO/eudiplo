import Joi from "joi";

export const AUTH_VALIDATION_SCHEMA: Joi.ObjectSchema = Joi.object({
    OIDC: Joi.string()
        .description(
            "Issuer URL of the Keycloak realm, for example `https://keycloak.example.com/realms/eudiplo`. Setting it switches the management API to OIDC mode (Keycloak only)",
        )
        .meta({ group: "auth", order: 10 }),

    OIDC_INTERNAL_ISSUER_URL: Joi.string()
        .uri()
        .when("OIDC", {
            is: Joi.exist(),
            then: Joi.string().default((config) => config.OIDC),
            otherwise: Joi.optional(),
        })
        .description("Internal issuer URL in OIDC mode")
        .meta({ group: "auth", order: 20, defaultText: "the value of `OIDC`" }),

    OIDC_CLIENT_ID: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().required(),
        otherwise: Joi.optional(),
    })
        .description("Client ID for OIDC")
        .meta({ group: "auth", order: 25 }),

    OIDC_CLIENT_SECRET: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().required(),
        otherwise: Joi.optional(),
    })
        .description("Client secret for OIDC")
        .meta({ group: "auth", order: 26 }),

    OIDC_SUB: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().default("tenant_id"),
        otherwise: Joi.optional(),
    })
        .description("Claim to use as subject")
        .meta({ group: "auth", order: 30 }),

    OIDC_ALGORITHM: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().valid("RS256", "PS256", "ES256").default("RS256"),
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

    JWT_EXPIRES_IN: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().default("24h"),
    })
        .description("Local JWT expiration")
        .meta({ group: "auth", order: 70 }),

    AUTH_CLIENT_SECRET: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().required(),
    })
        .description(
            "Client secret (local auth). In OIDC mode, optional bootstrap secret used to create/update a Keycloak admin/root client when AUTH_CLIENT_ID is also set",
        )
        .meta({ group: "auth", order: 80 }),

    AUTH_CLIENT_ID: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().optional(),
        otherwise: Joi.string().required(),
    })
        .description(
            "Client ID (local auth). In OIDC mode, optional bootstrap client ID used to create/update a Keycloak admin/root client when AUTH_CLIENT_SECRET is also set",
        )
        .meta({ group: "auth", order: 90 }),

    OIDC_UI_CLIENT_ID: Joi.when("OIDC", {
        is: Joi.exist(),
        then: Joi.string().default("eudiplo-ui"),
        otherwise: Joi.optional(),
    })
        .description(
            "Public client ID for the Angular UI in OIDC mode. Used to register a public Keycloak client for Authorization Code + PKCE login.",
        )
        .meta({ group: "auth", order: 95 }),
}).unknown(true);
