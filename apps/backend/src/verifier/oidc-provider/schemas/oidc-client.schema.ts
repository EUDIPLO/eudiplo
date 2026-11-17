import { z } from "zod";
import { MAX_CLIENT_SCOPES } from "../domain/oidc-client.js";

const OidcClientScopeSchema = z
    .object({
        scope: z
            .string()
            .min(1)
            .describe(
                "Scope the client requests next to `openid`. Letters, digits and `_.:-`, at most 64 characters; `openid` is reserved.",
            ),
        presentationConfigId: z
            .string()
            .min(1)
            .describe(
                "Presentation config that verifies a sign-in with this scope. It must not define transaction data.",
            ),
    })
    .strict()
    .describe("A scope of the client and the presentation config behind it.");

const name = z.string().min(1).max(200).describe("Display name of the client.");
const redirectUris = z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
        "Redirect URIs, matched exactly. HTTPS is required; HTTP only for localhost.",
    );
const profile = z
    .enum(["secure", "basic"])
    .describe(
        "`secure` requires a pushed authorization request (PAR); `basic` also accepts the parameters at the authorization endpoint directly.",
    );
const scopes = z
    .array(OidcClientScopeSchema)
    .max(MAX_CLIENT_SCOPES)
    .describe(
        "Scopes the client may request, each with one presentation config.",
    );

const subject = z
    .object({
        credentialId: z
            .string()
            .min(1)
            .describe(
                "ID of the credential query (DCQL) that holds the claim.",
            ),
        claim: z
            .string()
            .min(1)
            .max(200)
            .describe(
                "Dot-separated path to the claim, e.g. `personal_administrative_number`. A string or number.",
            ),
    })
    .strict()
    .nullable()
    .describe(
        "Claim that identifies a user across sign-ins. `sub` becomes a hash of it, the same for each sign-in of that user with this client; a sign-in whose presentation lacks it fails. Without it, `sub` is new for every sign-in.",
    );
const claimsFrom = z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .describe(
        "ID of a credential query (DCQL) whose claims are also put at the top level of the ID token, next to `credentials`, so a relying party can map `given_name` directly. The token's own claims (`iss`, `sub`, `aud` and so on) are never replaced.",
    );

export const CreateOidcClientSchema = z
    .object({
        name,
        redirectUris,
        profile: profile.default("secure"),
        scopes: scopes.default([]),
        subject: subject.optional(),
        claimsFrom: claimsFrom.optional(),
    })
    .strict()
    .describe("Payload for creating an OpenID Connect client.");

export const UpdateOidcClientSchema = z
    .object({
        name: name.optional(),
        redirectUris: redirectUris.optional(),
        profile: profile.optional(),
        scopes: scopes.optional(),
        subject: subject.optional(),
        claimsFrom: claimsFrom.optional(),
    })
    .strict()
    .describe(
        "Payload for changing an OpenID Connect client. Scopes are replaced as a whole.",
    );

export const UpdateOidcClientSecretSchema = z
    .object({
        expiresAt: z.iso
            .datetime({ offset: true })
            .nullable()
            .describe(
                "Moment from which the secret is refused, or null to keep it valid.",
            ),
    })
    .strict()
    .describe("Payload for changing a client secret.");

export type CreateOidcClient = z.infer<typeof CreateOidcClientSchema>;
export type UpdateOidcClient = z.infer<typeof UpdateOidcClientSchema>;
export type UpdateOidcClientSecret = z.infer<
    typeof UpdateOidcClientSecretSchema
>;
