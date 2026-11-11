import { deflateSync } from "node:zlib";
import { ES256 } from "@owf/crypto";
import { StatusList } from "@owf/token-status-list";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { RevocationListUnavailableError } from "../../../../trust/revocation-policy.util.js";
import {
    InvalidStatusListTokenError,
    StatusListVerifierService,
} from "../../../../trust/status-list-verifier.service.js";
import type { VerifierOptions } from "../../../../trust/types.js";
import {
    SdJwtVerificationError,
    SdjwtvcverifierService,
} from "./sdjwtvcverifier.service.js";

/**
 * The status of a presented SD-JWT VC, verified with the real
 * @sd-jwt/sd-jwt-vc library (the other spec mocks it) and read with the real
 * StatusListVerifierService; only fetching the list is stubbed. The issuer is
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

/**
 * Status list token signed by `signer`, by default for {@link STATUS_URI}
 * with 128 statuses that are all valid.
 */
function statusList(
    signer: Issuer,
    {
        list = new Uint8Array(16),
        lst = deflateSync(list),
        sub = STATUS_URI,
        iat = Math.floor(Date.now() / 1000) - 600,
        nbf,
        exp,
    }: {
        list?: Uint8Array;
        lst?: Uint8Array;
        sub?: string;
        iat?: number;
        nbf?: number;
        exp?: number;
    } = {},
): Promise<string> {
    return signJwt(
        signer,
        { alg: "ES256", typ: "statuslist+jwt", kid: KID },
        {
            sub,
            iat,
            ...(nbf === undefined ? {} : { nbf }),
            ...(exp === undefined ? {} : { exp }),
            ttl: 300,
            status_list: { bits: 1, lst: b64url(lst) },
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
    const statusLists = new StatusListVerifierService({} as any);
    const getStatusListJwt = vi
        .spyOn(statusLists, "getStatusListJwt")
        .mockResolvedValue(await statusList(issuer));
    const service = new SdjwtvcverifierService(
        {} as any,
        { getCryptoFromJwk: () => ES256 } as any,
        {} as any,
        statusLists,
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
        {
            enabled = true,
            failClosed = true,
            expiresIn,
        }: { enabled?: boolean; failClosed?: boolean; expiresIn?: number } = {},
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
                revocation: { enabled, failClosed },
            },
            skewSeconds: 60,
        } as VerifierOptions);
    return { verify, issuer, getStatusListJwt };
}

describe("SdjwtvcverifierService status reference", () => {
    it("checks a well-formed status_list reference", async () => {
        const { verify, getStatusListJwt } = await setup();

        const result = await verify({
            status_list: { uri: STATUS_URI, idx: 7 },
        });

        expect(result.payload).toMatchObject({ given_name: "Erika" });
        expect(getStatusListJwt).toHaveBeenCalledExactlyOnceWith(STATUS_URI);
    });

    it("checks the reference only after the credential itself", async () => {
        // Token Status List Section 8.3: an expired credential fails for its
        // expiry, whatever its status reference says.
        const { verify, getStatusListJwt } = await setup();

        const error = await verify(
            { status_list: { uri: STATUS_URI, idx: "7" } },
            { expiresIn: -3600 },
        ).catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(SdJwtVerificationError);
        expect(String(error)).toMatch(/expired/i);
        expect(getStatusListJwt).not.toHaveBeenCalled();
    });

    describe("without a status check", () => {
        // Without a statusListFetcher the library would fetch the list with
        // the global fetch, outside the outbound URL policy.
        let globalFetch: ReturnType<typeof vi.spyOn>;
        beforeEach(() => {
            globalFetch = vi
                .spyOn(globalThis, "fetch")
                .mockRejectedValue(new Error("global fetch used"));
        });
        afterEach(() => {
            globalFetch.mockRestore();
        });

        it("neither checks nor fetches the reference when disabled", async () => {
            const { verify, getStatusListJwt } = await setup();

            const result = await verify(
                { status_list: { uri: STATUS_URI, idx: "7" } },
                { enabled: false, failClosed: false },
            );

            expect(result.payload).toMatchObject({ given_name: "Erika" });
            expect(getStatusListJwt).not.toHaveBeenCalled();
            expect(globalFetch).not.toHaveBeenCalled();
        });

        it.each([
            ["a status claim that is a string", "valid"],
            ["a status_list that is null", { status_list: null }],
        ])("accepts %s when disabled", async (_, status) => {
            const { verify } = await setup();

            await expect(
                verify(status, { enabled: false, failClosed: false }),
            ).resolves.toMatchObject({
                payload: expect.objectContaining({ given_name: "Erika" }),
            });
        });

        it("does not fetch the list again when best-effort mode skips it", async () => {
            const { verify, getStatusListJwt } = await setup();
            getStatusListJwt.mockRejectedValue(
                new RevocationListUnavailableError(
                    `Failed to fetch status list from ${STATUS_URI}: blocked`,
                ),
            );

            const result = await verify(
                { status_list: { uri: STATUS_URI, idx: 7 } },
                { failClosed: false },
            );

            expect(result.payload).toMatchObject({ given_name: "Erika" });
            expect(getStatusListJwt).toHaveBeenCalledOnce();
            expect(globalFetch).not.toHaveBeenCalled();
        });
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
                const { verify, getStatusListJwt } = await setup();

                const error = await verify(status, { failClosed }).catch(
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(SdJwtVerificationError);
                expect(error).toMatchObject({
                    failureType: "verification_error",
                    verboseReason: expect.stringMatching(/^The status/),
                });
                expect(getStatusListJwt).not.toHaveBeenCalled();
            },
        );
    });

    describe.each([
        ["strict", true],
        ["best-effort", false],
    ])("status list checks in %s mode", (_, failClosed) => {
        const reference = { status_list: { uri: STATUS_URI, idx: 7 } };

        it("rejects a credential its status list revokes", async () => {
            const { verify, issuer, getStatusListJwt } = await setup();
            const list = new Uint8Array(16);
            list[0] = 0b1000_0000; // idx 7
            getStatusListJwt.mockResolvedValue(
                await statusList(issuer, { list }),
            );

            await expect(verify(reference, { failClosed })).rejects.toThrow(
                "Status is not valid",
            );
        });

        it("rejects a status list signed by another key", async () => {
            const { verify, getStatusListJwt } = await setup();
            getStatusListJwt.mockResolvedValue(
                await statusList(await createIssuer()),
            );

            await expect(verify(reference, { failClosed })).rejects.toThrow(
                "Status List JWT verification failed",
            );
        });

        it("rejects a status list for another URI", async () => {
            const { verify, issuer, getStatusListJwt } = await setup();
            getStatusListJwt.mockResolvedValue(
                await statusList(issuer, { sub: `${STATUS_URI}/other` }),
            );

            await expect(verify(reference, { failClosed })).rejects.toThrow(
                "does not match the status list URI",
            );
        });

        it("rejects an index outside the list", async () => {
            const { verify } = await setup();

            await expect(
                verify(
                    { status_list: { uri: STATUS_URI, idx: 128 } },
                    { failClosed },
                ),
            ).rejects.toThrow("outside the list");
        });

        it("accepts a status list that expired within the clock skew", async () => {
            const { verify, issuer, getStatusListJwt } = await setup();
            getStatusListJwt.mockResolvedValue(
                await statusList(issuer, {
                    exp: Math.floor(Date.now() / 1000) - 30,
                }),
            );

            await expect(
                verify(reference, { failClosed }),
            ).resolves.toMatchObject({ payload: { given_name: "Erika" } });
        });

        it.each([
            ["iat", { iat: Math.floor(Date.now() / 1000) + 120 }],
            ["nbf", { nbf: Math.floor(Date.now() / 1000) + 120 }],
        ])(
            "rejects a status list whose %s is beyond the clock skew",
            async (_, claims) => {
                const { verify, issuer, getStatusListJwt } = await setup();
                getStatusListJwt.mockResolvedValue(
                    await statusList(issuer, claims),
                );

                await expect(verify(reference, { failClosed })).rejects.toThrow(
                    "Status List JWT verification failed",
                );
            },
        );

        it("rejects a status list that expired before the clock skew", async () => {
            const { verify, issuer, getStatusListJwt } = await setup();
            getStatusListJwt.mockResolvedValue(
                await statusList(issuer, {
                    exp: Math.floor(Date.now() / 1000) - 120,
                }),
            );

            await expect(verify(reference, { failClosed })).rejects.toThrow(
                /expired/,
            );
        });
    });

    // RP_PP_SM_Revocation_016a_UF of the RP conformance suite serves a signed
    // status list of about a megabyte that decompresses to 1 GiB; this one
    // decompresses to 64 MiB.
    describe("status list that decompresses to more than 16 MiB", () => {
        const inflatedBytes = 64 * 1024 * 1024;
        let bomb: Uint8Array;
        let libraryDecompress: ReturnType<typeof vi.spyOn>;

        beforeAll(() => {
            bomb = deflateSync(new Uint8Array(inflatedBytes));
        });
        beforeEach(() => {
            libraryDecompress = vi.spyOn(
                StatusList,
                "decompressStatusListFromBytes",
            );
        });
        afterEach(() => {
            libraryDecompress.mockRestore();
        });

        it.each([
            ["strict", true],
            ["best-effort", false],
        ])(
            "rejects the credential in %s mode without decompressing the list",
            async (_, failClosed) => {
                const { verify, issuer, getStatusListJwt } = await setup();
                getStatusListJwt.mockResolvedValue(
                    await statusList(issuer, { lst: bomb }),
                );

                const error = await verify(
                    { status_list: { uri: STATUS_URI, idx: 7 } },
                    { failClosed },
                ).catch((e: unknown) => e);

                // Decompression stopped at the limit, and the library, which
                // turns every status into a number, never saw the list.
                expect(error).toBeInstanceOf(InvalidStatusListTokenError);
                expect((error as Error).message).toContain(
                    `at most ${16 * 1024 * 1024} bytes`,
                );
                expect(libraryDecompress).not.toHaveBeenCalled();
            },
        );

        it("still checks the next credential's status list", async () => {
            const { verify, issuer, getStatusListJwt } = await setup();
            getStatusListJwt
                .mockResolvedValueOnce(await statusList(issuer, { lst: bomb }))
                .mockResolvedValueOnce(await statusList(issuer));
            const reference = { status_list: { uri: STATUS_URI, idx: 7 } };

            await expect(verify(reference)).rejects.toBeInstanceOf(
                InvalidStatusListTokenError,
            );
            await expect(verify(reference)).resolves.toMatchObject({
                payload: { given_name: "Erika" },
            });
        });
    });
});
