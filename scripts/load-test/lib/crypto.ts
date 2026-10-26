/**
 * WebCrypto utilities for the wallet side of the load tests: OID4VCI proof
 * JWTs, SD-JWT presentations with key binding, and the JWE-encrypted OID4VP
 * response (`direct_post.jwt`).
 *
 * k6 v2.x exposes the WebCrypto API as a built-in global `crypto` object
 * (no import required). All exported functions are async because the
 * WebCrypto API is Promise-based.
 */

// `crypto` is a global in k6 v2.x — no import needed.
import encoding from 'k6/encoding';

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

/**
 * Encode a value as base64url (no padding).
 */
export function b64url(data: ArrayBuffer | Uint8Array | string): string {
    if (typeof data === 'string') {
        // Treat as UTF-8 string
        return encoding.b64encode(data, 'rawurl');
    }
    if (data instanceof ArrayBuffer) {
        return encoding.b64encode(new Uint8Array(data), 'rawurl');
    }
    // Uint8Array or similar typed array
    return encoding.b64encode(data, 'rawurl');
}

/**
 * JSON-encode an object then base64url-encode the result.
 */
export function b64urlJson(obj: unknown): string {
    return b64url(JSON.stringify(obj));
}

/**
 * UTF-8 encode a string. Not every k6 version has a `TextEncoder` global,
 * so round-trip through k6's base64 module, which encodes strings as UTF-8.
 */
export function utf8Bytes(input: string): Uint8Array {
    return new Uint8Array(encoding.b64decode(encoding.b64encode(input)));
}

/**
 * Decode a base64url string into a UTF-8 string.
 */
export function b64urlDecodeString(data: string): string {
    return encoding.b64decode(data, 'rawurl', 's') as string;
}

/**
 * Decode the payload of a compact JWS/JWT without verifying the signature.
 * The load test trusts the backend; verification is the wallet's job.
 */
export function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T {
    const parts = jwt.split('.');
    if (parts.length < 2) {
        throw new Error('Not a compact JWT');
    }
    return JSON.parse(b64urlDecodeString(parts[1])) as T;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** SD-JWT `_sd_alg` values (IANA hash names) and their WebCrypto names. */
const SD_HASH_ALGS: Record<string, string> = {
    'sha-256': 'SHA-256',
    'sha-384': 'SHA-384',
    'sha-512': 'SHA-512',
};

/**
 * WebCrypto name of the hash an SD-JWT uses for disclosures and `sd_hash`.
 * RFC 9901 §4.1.1: `sha-256` when `_sd_alg` is absent.
 */
export function sdHashAlg(sdAlg: unknown): string {
    const name = typeof sdAlg === 'string' ? sdAlg.toLowerCase() : 'sha-256';
    const webCrypto = SD_HASH_ALGS[name];
    if (!webCrypto) {
        throw new Error(`Unsupported _sd_alg "${String(sdAlg)}"; supported: ${Object.keys(SD_HASH_ALGS).join(', ')}`);
    }
    return webCrypto;
}

/** Digest of a UTF-8 string, as base64url (default SHA-256). */
export async function hashB64url(input: string, alg = 'SHA-256'): Promise<string> {
    return b64url(await crypto.subtle.digest(alg, utf8Bytes(input)));
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * Generate a fresh ECDSA P-256 key pair.
 */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, // extractable
        ['sign', 'verify'],
    );
}

/**
 * Export a CryptoKeyPair to plain JWK objects.
 * The private JWK includes the 'd' component; the public JWK does not.
 */
export async function exportKeyPair(
    keyPair: CryptoKeyPair,
): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    // Build a public JWK without 'd' from the private JWK
    const { d: _d, ...publicJwk } = privateJwk;
    return { privateJwk, publicJwk };
}

/**
 * Import a private JWK back into a CryptoKey for signing.
 */
export async function importPrivateKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'jwk',
        privateJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, // not extractable once imported per-VU
        ['sign'],
    );
}

/**
 * Per-VU cache for the imported holder key. Each VU has its own JS runtime,
 * so a module-level variable is per VU; importing the JWK once per VU
 * instead of once per iteration keeps the load generator's CPU for the
 * signatures that matter.
 */
let holderKeyCache: { jwk: string; key: CryptoKey } | undefined;

export async function holderPrivateKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
    const id = JSON.stringify(privateJwk);
    if (!holderKeyCache || holderKeyCache.jwk !== id) {
        holderKeyCache = { jwk: id, key: await importPrivateKey(privateJwk) };
    }
    return holderKeyCache.key;
}

// ---------------------------------------------------------------------------
// JWS
// ---------------------------------------------------------------------------

/** Sign `header.payload` with ES256 and return the compact JWS. */
export async function signJws(
    privateKey: CryptoKey,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
): Promise<string> {
    const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;

    // WebCrypto sign() returns the signature in IEEE P1363 format (r || s),
    // which is the correct raw format for ES256 JWS signatures.
    const sigBytes = await crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        privateKey,
        utf8Bytes(signingInput),
    );

    return `${signingInput}.${b64url(sigBytes)}`;
}

// ---------------------------------------------------------------------------
// OID4VCI proof JWT
// ---------------------------------------------------------------------------

/**
 * Sign an OID4VCI key-binding proof JWT using ECDSA P-256 / SHA-256.
 *
 * The JWT follows the OpenID4VCI specification:
 *   - Header: { typ: "openid4vci-proof+jwt", alg: "ES256", jwk: <public key JWK> }
 *   - Payload: { aud: <credential issuer URL>, iat: <now (seconds)>, nonce: <c_nonce> }
 */
export async function signProofJwt(
    privateKey: CryptoKey,
    publicJwk: JsonWebKey,
    cNonce: string,
    audience: string,
): Promise<string> {
    return signJws(
        privateKey,
        { typ: 'openid4vci-proof+jwt', alg: 'ES256', jwk: publicJwk },
        { aud: audience, iat: Math.floor(Date.now() / 1000), nonce: cNonce },
    );
}

// ---------------------------------------------------------------------------
// SD-JWT presentation
// ---------------------------------------------------------------------------

interface Disclosure {
    /** The base64url-encoded disclosure as it appears in the SD-JWT. */
    encoded: string;
    /** base64url(hash(encoded)) — the digest referenced from `_sd` arrays. */
    digest: string;
    /** Claim name (undefined for array element disclosures). */
    name?: string;
    value: unknown;
}

async function parseDisclosures(encoded: string[], hashAlg: string): Promise<Disclosure[]> {
    const out: Disclosure[] = [];
    for (const d of encoded) {
        const parsed = JSON.parse(b64urlDecodeString(d)) as unknown[];
        // [salt, name, value] for object properties; [salt, value] for array elements
        const name = parsed.length === 3 ? (parsed[1] as string) : undefined;
        const value = parsed[parsed.length - 1];
        out.push({ encoded: d, digest: await hashB64url(d, hashAlg), name, value });
    }
    return out;
}

/**
 * Select the disclosures of an issued SD-JWT VC that reveal the given claim
 * paths (as in a DCQL `claims[].path`), including the parent disclosures
 * needed to reach nested claims. Returns the presentation without key
 * binding: `<issuer-jwt>~<disclosure>~...~`.
 *
 * Paths that are not selectively disclosable (plain claims) need no
 * disclosure and are accepted. A path that cannot be resolved throws, so a
 * misconfigured scenario fails loudly instead of presenting the wrong
 * claims.
 */
export async function selectDisclosures(
    sdJwt: string,
    claimPaths: Array<Array<string | number | null>>,
): Promise<string> {
    const parts = sdJwt.split('~');
    const issuerJwt = parts[0];
    // Drop a trailing KB-JWT / empty segment.
    const encodedDisclosures = parts.slice(1).filter((p) => p.length > 0 && !p.includes('.'));
    const payload = decodeJwtPayload<Record<string, unknown>>(issuerJwt);
    const disclosures = await parseDisclosures(encodedDisclosures, sdHashAlg(payload._sd_alg));
    const byDigest = new Map(disclosures.map((d) => [d.digest, d]));

    const selected = new Set<string>();

    for (const path of claimPaths) {
        let node: unknown = payload;
        for (const segment of path) {
            if (node === null || typeof node !== 'object') {
                throw new Error(`Claim path ${JSON.stringify(path)} not found in credential`);
            }
            const obj = node as Record<string, unknown>;

            if (segment === null || typeof segment === 'number') {
                // Array element(s): disclose all / the indexed element.
                if (!Array.isArray(node)) {
                    throw new Error(`Claim path ${JSON.stringify(path)} expects an array`);
                }
                const elements = segment === null ? node : [node[segment]];
                const resolved: unknown[] = [];
                for (const el of elements) {
                    const ref = (el as { '...': string })?.['...'];
                    if (ref && byDigest.has(ref)) {
                        const d = byDigest.get(ref)!;
                        selected.add(d.encoded);
                        resolved.push(d.value);
                    } else {
                        resolved.push(el);
                    }
                }
                node = segment === null ? resolved : resolved[0];
                continue;
            }

            if (segment in obj) {
                node = obj[segment];
                continue;
            }

            const sd = (obj._sd as string[] | undefined) ?? [];
            const match = sd
                .map((digest) => byDigest.get(digest))
                .find((d) => d && d.name === segment);
            if (!match) {
                throw new Error(
                    `Claim "${segment}" of path ${JSON.stringify(path)} is neither plain nor disclosable`,
                );
            }
            selected.add(match.encoded);
            node = match.value;
        }
    }

    // Keep the issuer's disclosure order; the order is not significant, but
    // stable output makes debugging easier.
    const ordered = encodedDisclosures.filter((d) => selected.has(d));
    return `${issuerJwt}~${ordered.map((d) => `${d}~`).join('')}`;
}

/**
 * Append a Key Binding JWT to an SD-JWT presentation (which must end with `~`).
 * `sd_hash` uses the issuer JWT's `_sd_alg` (RFC 9901 §4.3.1: the same hash
 * algorithm as for the disclosures).
 */
export async function addKeyBinding(
    presentation: string,
    holderKey: CryptoKey,
    audience: string,
    nonce: string,
): Promise<string> {
    const kb = await signJws(
        holderKey,
        { typ: 'kb+jwt', alg: 'ES256' },
        {
            iat: Math.floor(Date.now() / 1000),
            aud: audience,
            nonce,
            sd_hash: await hashB64url(
                presentation,
                sdHashAlg(decodeJwtPayload(presentation.split('~')[0])._sd_alg),
            ),
        },
    );
    return `${presentation}${kb}`;
}

// ---------------------------------------------------------------------------
// JWE (ECDH-ES + AES-GCM) for the encrypted authorization response
// ---------------------------------------------------------------------------

function u32be(n: number): Uint8Array {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function lengthPrefixed(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + data.length);
    out.set(u32be(data.length), 0);
    out.set(data, 4);
    return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/**
 * Concat KDF (NIST SP 800-56A) with SHA-256 as used by JWA ECDH-ES in
 * direct key agreement mode: a single hash round suffices for key sizes up
 * to 256 bits.
 */
async function concatKdf(
    sharedSecret: ArrayBuffer,
    algorithmId: string,
    keyBits: number,
): Promise<ArrayBuffer> {
    const input = concatBytes(
        u32be(1),
        new Uint8Array(sharedSecret),
        lengthPrefixed(utf8Bytes(algorithmId)), // AlgorithmID
        lengthPrefixed(new Uint8Array(0)), // PartyUInfo (apu) — empty
        lengthPrefixed(new Uint8Array(0)), // PartyVInfo (apv) — empty
        u32be(keyBits), // SuppPubInfo
    );
    const digest = await crypto.subtle.digest('SHA-256', input);
    return digest.slice(0, keyBits / 8);
}

export type JweEnc = 'A128GCM' | 'A256GCM';

/**
 * Encrypt a JSON payload for the verifier as a compact JWE with
 * `alg: ECDH-ES` and `enc: A128GCM | A256GCM`, the combination EUDIPLO
 * advertises in `client_metadata`.
 */
export async function encryptJwe(
    payload: Record<string, unknown>,
    recipientJwk: JsonWebKey,
    enc: JweEnc = 'A128GCM',
): Promise<string> {
    const keyBits = enc === 'A256GCM' ? 256 : 128;

    const recipientKey = await crypto.subtle.importKey(
        'jwk',
        { kty: recipientJwk.kty, crv: recipientJwk.crv, x: recipientJwk.x, y: recipientJwk.y },
        { name: 'ECDH', namedCurve: recipientJwk.crv ?? 'P-256' },
        false,
        [],
    );
    const ephemeral = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: recipientJwk.crv ?? 'P-256' },
        true,
        ['deriveBits'],
    );
    const epk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);

    const sharedSecret = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: recipientKey },
        ephemeral.privateKey,
        256,
    );
    const cekBytes = await concatKdf(sharedSecret, enc, keyBits);
    const cek = await crypto.subtle.importKey('raw', cekBytes, { name: 'AES-GCM' }, false, [
        'encrypt',
    ]);

    const header: Record<string, unknown> = {
        alg: 'ECDH-ES',
        enc,
        epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y },
    };
    if (recipientJwk.kid) {
        header.kid = recipientJwk.kid;
    }
    const protectedHeader = b64urlJson(header);

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData: utf8Bytes(protectedHeader),
                tagLength: 128,
            },
            cek,
            utf8Bytes(JSON.stringify(payload)),
        ),
    );
    const ciphertext = sealed.slice(0, sealed.length - 16);
    const tag = sealed.slice(sealed.length - 16);

    // Compact serialization; the encrypted key is empty for ECDH-ES.
    return `${protectedHeader}..${b64url(iv)}.${b64url(ciphertext)}.${b64url(tag)}`;
}
