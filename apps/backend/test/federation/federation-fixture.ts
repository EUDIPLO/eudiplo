import {
    createEntityConfiguration,
    createEntityStatement,
    type JsonWebKey,
} from "@openid-federation/core";
import { exportJWK, generateKeyPair } from "jose";
import nock from "nock";

/**
 * A signed OpenID Federation served through nock, built with
 * `@openid-federation/core`: entity configurations at
 * `{id}/.well-known/openid-federation` and subordinate statements at
 * `{id}/fetch?sub=...`.
 */

const CONTENT_TYPE = { "content-type": "application/entity-statement+jwt" };
const HEADER = { typ: "entity-statement+jwt", alg: "ES256" } as const;

export interface FederationKey {
    jwk: JsonWebKey;
    privateKey: CryptoKey;
}

/** An ES256 key with `kid`, as federation or protocol key. */
export async function federationKey(kid: string): Promise<FederationKey> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
        extractable: true,
    });
    return {
        jwk: {
            ...(await exportJWK(publicKey)),
            kid,
            alg: "ES256",
        } as JsonWebKey,
        privateKey: privateKey as CryptoKey,
    };
}

function signer(key: FederationKey) {
    return async ({ toBeSigned }: { toBeSigned: Uint8Array }) =>
        new Uint8Array(
            await globalThis.crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" },
                key.privateKey,
                toBeSigned as BufferSource,
            ),
        );
}

const now = () => Math.floor(Date.now() / 1000);

/** Serves the entity configuration of `id`, signed with `key`. */
async function serveEntityConfiguration(options: {
    id: string;
    key: FederationKey;
    authorityHints?: string[];
    metadata?: Record<string, Record<string, unknown>>;
}) {
    const jwt = await createEntityConfiguration({
        signJwtCallback: signer(options.key),
        header: { ...HEADER, kid: options.key.jwk.kid },
        claims: {
            iss: options.id,
            sub: options.id,
            iat: now(),
            exp: now() + 3600,
            jwks: { keys: [options.key.jwk] },
            authority_hints: options.authorityHints,
            metadata: {
                federation_entity: {
                    federation_fetch_endpoint: `${options.id}/fetch`,
                },
                ...options.metadata,
            },
        },
    });
    nock(options.id)
        .get("/.well-known/openid-federation")
        .optionally()
        .reply(200, jwt, CONTENT_TYPE);
    return jwt;
}

/**
 * Serves the subordinate statement of `issuer` about `subject`, listing the
 * subject's federation key. `listed: false` answers 404 instead, as for an
 * entity the issuer does not list.
 */
async function serveSubordinateStatement(options: {
    issuer: string;
    issuerKey: FederationKey;
    subject: string;
    subjectKey: FederationKey;
    listed?: boolean;
}) {
    const scope = nock(options.issuer)
        .get("/fetch")
        .query({ sub: options.subject })
        .optionally();
    if (options.listed === false) {
        scope.reply(404);
        return;
    }
    const jwt = await createEntityStatement({
        signJwtCallback: signer(options.issuerKey),
        jwk: options.issuerKey.jwk,
        header: { ...HEADER, kid: options.issuerKey.jwk.kid } as never,
        claims: {
            iss: options.issuer,
            sub: options.subject,
            iat: now(),
            exp: now() + 3600,
            jwks: { keys: [options.subjectKey.jwk] },
        },
    });
    scope.reply(200, jwt, CONTENT_TYPE);
}

/** Serves `trustAnchor` and `entity` directly below it. */
export async function serveFederation(options: {
    trustAnchor: string;
    entity: string;
    /** The trust anchor the entity names; defaults to `trustAnchor`. */
    authorityHint?: string;
    metadata: Record<string, Record<string, unknown>>;
    /** Whether the trust anchor lists the entity as subordinate. */
    listed?: boolean;
}) {
    const trustAnchorKey = await federationKey("trust-anchor");
    const entityKey = await federationKey("entity-federation-key");
    await serveEntityConfiguration({
        id: options.trustAnchor,
        key: trustAnchorKey,
    });
    await serveEntityConfiguration({
        id: options.entity,
        key: entityKey,
        authorityHints: [options.authorityHint ?? options.trustAnchor],
        metadata: options.metadata,
    });
    await serveSubordinateStatement({
        issuer: options.trustAnchor,
        issuerKey: trustAnchorKey,
        subject: options.entity,
        subjectKey: entityKey,
        listed: options.listed,
    });
}
