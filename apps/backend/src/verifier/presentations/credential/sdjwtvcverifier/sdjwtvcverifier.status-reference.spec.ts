import { deflateSync } from "node:zlib";
import { ES256 } from "@owf/crypto";
import { describe, expect, it, vi } from "vitest";
import type { VerifierOptions } from "../../../../trust/types.js";
import {
    SdJwtVerificationError,
    SdjwtvcverifierService,
} from "./sdjwtvcverifier.service.js";

/**
 * The status reference of a presented SD-JWT VC, checked with the real
 * @sd-jwt/sd-jwt-vc library (the other spec mocks it). The issuer is
 * resolved through OpenID Federation, so no certificate chain is needed.
 */

const ISSUER = "https://issuer.example.org";
const STATUS_URI = "https://issuer.example.org/status/1";
const KID = "issuer-key";

const b64url = (value: string | ArrayBuffer | Uint8Array) =>
    Buffer.from(
        typeof value === "string"
            ? value
            : new Uint8Array(value as ArrayBuffer),
    ).toString("base64url");

async function createIssuer() {
    const keys = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
        "jwk",
        keys.publicKey,
    );
    return { privateKey: keys.privateKey, jwk: { kty, crv, x, y, kid: KID } };
}

type Issuer = Awaited<ReturnType<typeof createIssuer>>;

async function signJwt(
    issuer: Issuer,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
): Promise<string> {
    const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        issuer.privateKey,
        new TextEncoder().encode(data),
    );
    return `${data}.${b64url(signature)}`;
}

/** SD-JWT VC without disclosures whose payload carries `status`. */
async function credential(
    issuer: Issuer,
    status: unknown,
    expiresIn = 3600,
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(
        issuer,
        { alg: "ES256", typ: "dc+sd-jwt", kid: KID },
        {
            iss: ISSUER,
            vct: "urn:eudi:pid:1",
            iat: now,
            exp: now + expiresIn,
            _sd_alg: "sha-256",
            given_name: "Erika",
            ...(status === undefined ? {} : { status }),
        },
    );
    return `${jwt}~`;
}

/** Status list token for {@link STATUS_URI} in which every status is valid. */
function statusList(issuer: Issuer): Promise<string> {
    return signJwt(
        issuer,
        { alg: "ES256", typ: "statuslist+jwt", kid: KID },
        {
            sub: STATUS_URI,
            iat: Math.floor(Date.now() / 1000) - 60,
            ttl: 300,
            status_list: {
                bits: 1,
                lst: b64url(deflateSync(new Uint8Array(16))),
            },
        },
    );
}

async function setup() {
    const issuer = await createIssuer();
    const resolution = {
        entityId: ISSUER,
        trustAnchor: "https://ta.example.org",
        trustChain: ["ec", "ss", "ta"],
        metadata: {
            openid_credential_issuer: { jwks: { keys: [issuer.jwk] } },
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const list = await statusList(issuer);
    const chainValidation = {
        fetchStatusListJwt: vi.fn().mockResolvedValue(list),
    };
    const service = new SdjwtvcverifierService(
        {} as any,
        { getCryptoFromJwk: () => ES256 } as any,
        chainValidation as any,
        {
            resolveCredentialIssuerKey: vi
                .fn()
                .mockResolvedValue({ jwk: issuer.jwk, resolution }),
        } as any,
        {
            setContext: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        } as any,
    );
    const verify = async (
        status: unknown,
        failClosed = true,
        expiresIn?: number,
    ) =>
        service.verify(await credential(issuer, status, expiresIn), {
            federationTrustSource: {
                mode: "federation-only",
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
            policy: {
                requireX5c: false,
                revocation: { enabled: true, failClosed },
            },
        } as VerifierOptions);
    return { verify, fetchStatusListJwt: chainValidation.fetchStatusListJwt };
}

describe("SdjwtvcverifierService status reference", () => {
    it("checks a well-formed status_list reference", async () => {
        const { verify, fetchStatusListJwt } = await setup();

        const result = await verify({
            status_list: { uri: STATUS_URI, idx: 7 },
        });

        expect(result.payload).toMatchObject({ given_name: "Erika" });
        expect(fetchStatusListJwt).toHaveBeenCalledExactlyOnceWith(STATUS_URI);
    });

    it("checks the reference only after the credential itself", async () => {
        // Token Status List Section 8.3: an expired credential fails for its
        // expiry, whatever its status reference says.
        const { verify, fetchStatusListJwt } = await setup();

        const error = await verify(
            { status_list: { uri: STATUS_URI, idx: "7" } },
            true,
            -3600,
        ).catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(SdJwtVerificationError);
        expect(String(error)).toMatch(/expired/i);
        expect(fetchStatusListJwt).not.toHaveBeenCalled();
    });

    // RP_WS_SM_Revocation_005a_UF of the RP conformance suite.
    describe.each([
        ["strict", true],
        ["best-effort", false],
    ])("in %s mode", (_, failClosed) => {
        it.each([
            ["no idx", { status_list: { uri: STATUS_URI } }],
            ["no uri", { status_list: { idx: 7 } }],
            ["a negative idx", { status_list: { uri: STATUS_URI, idx: -1 } }],
            ["a string idx", { status_list: { uri: STATUS_URI, idx: "7" } }],
            [
                "a uri that is not a URI",
                { status_list: { uri: "not a uri", idx: 7 } },
            ],
            ["a status_list that is null", { status_list: null }],
            ["a status claim that is a string", "valid"],
        ])(
            "rejects a reference with %s without fetching a status list",
            async (_, status) => {
                const { verify, fetchStatusListJwt } = await setup();

                const error = await verify(status, failClosed).catch(
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(SdJwtVerificationError);
                expect(error).toMatchObject({
                    failureType: "verification_error",
                    verboseReason: expect.stringMatching(/^The status/),
                });
                expect(fetchStatusListJwt).not.toHaveBeenCalled();
            },
        );
    });
});
