import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";
import { Logger } from "@nestjs/common";
import { CoseKey, SignatureAlgorithm } from "@owf/mdoc";
import { StatusList, StatusListCwt } from "@owf/token-status-list";
import { base64url, exportJWK } from "jose";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { mdocContext } from "../verifier/presentations/mdoc-context.js";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import {
    InvalidStatusListTokenError,
    StatusListVerifierService,
} from "./status-list-verifier.service.js";
import { TrustFetchService } from "./trust-fetch.service.js";

const minute = 60_000;
const hour = 60 * minute;

/**
 * The status list URIs come from presented credentials, so the caches are
 * bounded and a token's own ttl cannot keep it cached for longer than an
 * hour. Status lists are served from a local server on EUDIPLO's own
 * PUBLIC_URL, which the outbound URL policy exempts.
 */
describe("StatusListVerifierService cache", () => {
    let server: Server;
    let origin: string;
    let requests: string[];
    let tokens: Map<string, string | Uint8Array>;
    let signingJwk: Record<string, unknown>;

    beforeAll(async () => {
        server = createServer((request, response) => {
            const path = request.url ?? "";
            requests.push(path);
            const token = tokens.get(path) ?? jwt({});
            response.writeHead(200, {
                "content-type":
                    typeof token === "string"
                        ? "application/statuslist+jwt"
                        : "application/statuslist+cwt",
            });
            response.end(token);
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        origin = `http://127.0.0.1:${port}`;

        const keys = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        );
        signingJwk = (await exportJWK(keys.privateKey)) as Record<
            string,
            unknown
        >;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
        tokens = new Map();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
        vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const service = () =>
        new StatusListVerifierService(
            new TrustFetchService(
                new OutboundUrlPolicyService({
                    get: vi.fn((_key: string, fallback?: unknown) => fallback),
                } as never),
                { publicUrl: origin },
            ),
        );

    const now = () => Math.floor(Date.now() / 1000);

    /** Status list JWT; the service does not verify its signature. */
    function jwt(
        claims: { ttl?: number; exp?: number; sub?: string },
        lst = deflateSync(new Uint8Array(1)),
    ): string {
        const encode = (value: unknown) =>
            base64url.encode(JSON.stringify(value));
        return [
            encode({ alg: "ES256", typ: "statuslist+jwt" }),
            encode({
                sub: "status-list",
                iat: now(),
                ...claims,
                status_list: { bits: 1, lst: base64url.encode(lst) },
            }),
            "c2ln",
        ].join(".");
    }

    async function cwt(claims: {
        ttl?: number;
        exp?: number;
    }): Promise<Uint8Array> {
        return new StatusListCwt({
            payload: {
                subject: "status-list",
                issuedAt: new Date(now() * 1000),
                expirationTime: claims.exp
                    ? new Date(claims.exp * 1000)
                    : undefined,
                timeToLive: claims.ttl,
                statusList: new StatusList([0, 0, 0, 0, 0, 0, 0, 0], 1),
            },
            protectedHeaders: new Map<number, unknown>([
                [1, SignatureAlgorithm.ES256],
            ]),
        }).signAndEncode(
            {
                signingKey: CoseKey.fromJwk(signingJwk),
                algorithm: SignatureAlgorithm.ES256,
            },
            { sign: mdocContext.cose.sign1.sign },
        );
    }

    const caches = [
        {
            name: "status list JWTs",
            token: (claims: { ttl?: number; exp?: number }) =>
                Promise.resolve(jwt(claims)),
            get: (statusLists: StatusListVerifierService, uri: string) =>
                statusLists.getStatusListJwt(uri, "tenant-a"),
        },
        {
            name: "status list CWTs",
            token: cwt,
            get: (statusLists: StatusListVerifierService, uri: string) =>
                statusLists.getStatusListCwt(uri, "tenant-a"),
        },
    ];

    describe.each(caches)("$name", ({ token, get }) => {
        it.each([
            {
                case: "for its ttl",
                claims: () => ({ ttl: 60 }),
                cachedFor: minute,
            },
            {
                case: "until its exp",
                claims: () => ({ ttl: 600, exp: now() + 120 }),
                cachedFor: 2 * minute,
            },
            {
                case: "for five minutes without a ttl",
                claims: () => ({}),
                cachedFor: 5 * minute,
            },
            {
                case: "for at most one hour, whatever its ttl",
                claims: () => ({ ttl: 30 * 24 * 3600, exp: now() + 31e5 }),
                cachedFor: hour,
            },
        ])("caches a token $case", async ({ claims, cachedFor }) => {
            const statusLists = service();
            const fetchedAt = Date.now();
            tokens.set("/list", await token(claims()));

            await get(statusLists, `${origin}/list`);
            vi.setSystemTime(fetchedAt + cachedFor - 1);
            await get(statusLists, `${origin}/list`);
            expect(requests).toEqual(["/list"]);

            vi.setSystemTime(fetchedAt + cachedFor);
            await get(statusLists, `${origin}/list`);
            expect(requests).toEqual(["/list", "/list"]);
        });

        it("does not report expired status lists", async () => {
            const statusLists = service();
            tokens.set("/short", await token({ ttl: 60 }));
            tokens.set("/long", await token({ ttl: 600 }));

            await get(statusLists, `${origin}/short`);
            await get(statusLists, `${origin}/long`);
            vi.setSystemTime(Date.now() + minute);

            expect(statusLists.getCacheStats().uris).toEqual([
                `${origin}/long`,
            ]);
        });
    });

    it("evicts the least recently used status list beyond 1000 entries", async () => {
        const statusLists = service();
        for (let i = 0; i < 1000; i++) {
            await statusLists.getStatusListJwt(
                `${origin}/list/${i}`,
                "tenant-a",
            );
        }
        await statusLists.getStatusListJwt(`${origin}/list/0`, "tenant-a");
        requests = [];

        await statusLists.getStatusListJwt(`${origin}/list/1000`, "tenant-a");

        const { jwtCacheSize, uris } = statusLists.getCacheStats();
        expect(jwtCacheSize).toBe(1000);
        expect(uris).toContain(`${origin}/list/0`);
        expect(uris).not.toContain(`${origin}/list/1`);
        await statusLists.getStatusListJwt(`${origin}/list/0`, "tenant-a");
        await statusLists.getStatusListJwt(`${origin}/list/1`, "tenant-a");
        expect(requests).toEqual(["/list/1000", "/list/1"]);
    }, 30_000);

    it("bounds decompressed status lists by their size", async () => {
        // A few kilobytes of token, 16 MiB decompressed each: the 64 MiB
        // budget holds three of them.
        const lst = deflateSync(Buffer.alloc(16 * 1024 * 1024));
        const statusLists = service();

        for (const uri of ["/big/1", "/big/2", "/big/3", "/big/4"]) {
            statusLists.getStatusFromStatusListJwt(
                jwt({ ttl: 600, sub: uri }, lst),
                { uri, idx: 0 },
            );
        }

        expect(statusLists.getCacheStats()).toMatchObject({
            size: 3,
            uris: ["/big/2", "/big/3", "/big/4"],
        });
    }, 30_000);

    it("clears one or all status lists", async () => {
        const statusLists = service();
        statusLists.getStatusFromStatusListJwt(jwt({ sub: `${origin}/a` }), {
            uri: `${origin}/a`,
            idx: 0,
        });
        await statusLists.getStatusListJwt(`${origin}/a`, "tenant-a");
        await statusLists.getStatusListJwt(`${origin}/b`, "tenant-a");
        tokens.set("/c", await cwt({}));
        await statusLists.getStatusListCwt(`${origin}/c`, "tenant-a");

        statusLists.clearCache(`${origin}/a`);
        expect(statusLists.getCacheStats()).toEqual({
            size: 0,
            jwtCacheSize: 1,
            uris: [`${origin}/b`, `${origin}/c`],
        });

        statusLists.clearCache();
        expect(statusLists.getCacheStats()).toEqual({
            size: 0,
            jwtCacheSize: 0,
            uris: [],
        });
    });

    it("lists and clears only the status lists a tenant used", async () => {
        const statusLists = service();
        await statusLists.getStatusListJwt(`${origin}/a`, "tenant-a");
        await statusLists.getStatusListJwt(`${origin}/b`, "tenant-b");
        await statusLists.getStatusListJwt(`${origin}/shared`, "tenant-a");
        await statusLists.getStatusListJwt(`${origin}/shared`, "tenant-b");
        await statusLists.getStatusListJwt(`${origin}/untracked`, undefined);

        expect(statusLists.getCacheStats("tenant-a")).toEqual({
            size: 0,
            jwtCacheSize: 2,
            uris: [`${origin}/a`, `${origin}/shared`],
        });

        statusLists.clearTenantCache("tenant-a");

        expect(statusLists.getCacheStats("tenant-a").uris).toEqual([]);
        // The shared list is fetched again by tenant-b, which then sees it.
        expect(statusLists.getCacheStats("tenant-b").uris).toEqual([
            `${origin}/b`,
        ]);
        expect(statusLists.getCacheStats().uris).toEqual([
            `${origin}/b`,
            `${origin}/untracked`,
        ]);
    });
});

describe("StatusListVerifierService.getStatusFromStatusListJwt", () => {
    const uri = "https://wallet-provider.example/status/1";
    const list = new StatusList([0, 1, 2, 0, 0, 0, 0, 3], 2);
    const lst = base64url.encode(list.compressStatusListToBytes());
    const now = () => Math.floor(Date.now() / 1000);

    function token(
        payload: Record<string, unknown> = {},
        header: Record<string, unknown> = { typ: "statuslist+jwt" },
    ): string {
        return [
            base64url.encode(JSON.stringify({ alg: "ES256", ...header })),
            base64url.encode(
                JSON.stringify({
                    sub: uri,
                    iat: now(),
                    exp: now() + 3600,
                    status_list: { bits: 2, lst },
                    ...payload,
                }),
            ),
            "c2ln",
        ].join(".");
    }

    let statusLists: StatusListVerifierService;
    beforeEach(() => {
        statusLists = new StatusListVerifierService({} as TrustFetchService);
    });

    it.each([
        { idx: 0, status: 0, isValid: true, description: "Valid" },
        { idx: 1, status: 1, isValid: false, description: "Invalid/Revoked" },
        { idx: 2, status: 2, isValid: false, description: "Suspended" },
        {
            idx: 7,
            status: 3,
            isValid: false,
            description: "Unknown status (3)",
        },
    ])("reads status $status at index $idx", ({ idx, ...expected }) => {
        expect(
            statusLists.getStatusFromStatusListJwt(token(), { uri, idx }),
        ).toEqual(expected);
    });

    it("reads every status of a one-bit list like the library", () => {
        const statuses = Array.from({ length: 64 }, (_, i) =>
            i % 3 === 0 ? 1 : 0,
        );
        const jwt = token({
            status_list: {
                bits: 1,
                lst: base64url.encode(
                    new StatusList(statuses, 1).compressStatusListToBytes(),
                ),
            },
        });
        expect(
            statuses.map(
                (_, idx) =>
                    statusLists.getStatusFromStatusListJwt(jwt, { uri, idx })
                        .status,
            ),
        ).toEqual(statuses);
    });

    it.each([
        { name: "an index outside the list", jwt: () => token(), idx: 8 },
        { name: "a negative index", jwt: () => token(), idx: -1 },
        { name: "a fractional index", jwt: () => token(), idx: 1.5 },
        {
            name: "another list's sub",
            jwt: () => token({ sub: `${uri}-other` }),
            idx: 0,
        },
        { name: "no sub", jwt: () => token({ sub: undefined }), idx: 0 },
        { name: "no iat", jwt: () => token({ iat: undefined }), idx: 0 },
        {
            name: "an exp in the past",
            jwt: () => token({ exp: now() - 1 }),
            idx: 0,
        },
        {
            name: "a typ other than statuslist+jwt",
            jwt: () => token({}, { typ: "JWT" }),
            idx: 0,
        },
        { name: "no typ", jwt: () => token({}, {}), idx: 0 },
        { name: "an undecodable token", jwt: () => "not-a-jwt", idx: 0 },
        {
            name: "an exp that is not a number",
            jwt: () => token({ exp: "tomorrow" }),
            idx: 0,
        },
        {
            name: "an exp of now",
            jwt: () => token({ exp: now() }),
            idx: 0,
        },
        {
            name: "no lst",
            jwt: () => token({ status_list: { bits: 1 } }),
            idx: 0,
        },
        {
            name: "invalid bits",
            jwt: () => token({ status_list: { bits: 3, lst } }),
            idx: 0,
        },
        {
            name: "an lst that is not DEFLATE",
            jwt: () =>
                token({ status_list: { bits: 1, lst: base64url.encode("x") } }),
            idx: 0,
        },
    ])("rejects a token with $name", ({ jwt, idx }) => {
        expect(() =>
            statusLists.getStatusFromStatusListJwt(jwt(), { uri, idx }),
        ).toThrow(InvalidStatusListTokenError);
    });

    it("accepts an exp within the clock tolerance", () => {
        expect(
            statusLists.getStatusFromStatusListJwt(
                token({ exp: now() - 5 }),
                { uri, idx: 0 },
                30,
            ).isValid,
        ).toBe(true);
    });

    it.each(["application/statuslist+jwt", "Statuslist+JWT"])(
        "accepts %s as typ",
        (typ) => {
            expect(
                statusLists.getStatusFromStatusListJwt(token({}, { typ }), {
                    uri,
                    idx: 0,
                }).isValid,
            ).toBe(true);
        },
    );

    it("rejects a list that decompresses to more than 16 MiB", () => {
        const bomb = deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1));
        expect(() =>
            statusLists.getStatusFromStatusListJwt(
                token({
                    status_list: { bits: 1, lst: base64url.encode(bomb) },
                }),
                { uri, idx: 0 },
            ),
        ).toThrow(/decompressed/);
    });

    it("decompresses a token once while it is served for the URI", () => {
        const cache = (
            statusLists as unknown as {
                inflatedLists: {
                    get: (k: string) => { jwt: string; bytes: Uint8Array };
                };
            }
        ).inflatedLists;
        const jwt = token();
        statusLists.getStatusFromStatusListJwt(jwt, { uri, idx: 0 });
        const first = cache.get(uri)?.bytes;
        statusLists.getStatusFromStatusListJwt(jwt, { uri, idx: 1 });
        expect(first).toBeDefined();
        expect(cache.get(uri)?.bytes).toBe(first);

        statusLists.clearCache(uri);
        statusLists.getStatusFromStatusListJwt(jwt, { uri, idx: 0 });
        expect(cache.get(uri)?.bytes).not.toBe(first);

        // Another token for the same URI replaces the cached list.
        const revoked = token({
            status_list: {
                bits: 2,
                lst: base64url.encode(
                    new StatusList([1, 1, 1, 1], 2).compressStatusListToBytes(),
                ),
            },
        });
        expect(
            statusLists.getStatusFromStatusListJwt(revoked, { uri, idx: 0 })
                .status,
        ).toBe(1);
        expect(cache.get(uri)?.jwt).toBe(revoked);
    });
});

describe("StatusListVerifierService.getStatusEntryFromJwt", () => {
    const statusLists = new StatusListVerifierService({} as TrustFetchService);
    const jwtWith = (payload: Record<string, unknown>) =>
        [
            base64url.encode(JSON.stringify({ alg: "ES256" })),
            base64url.encode(JSON.stringify(payload)),
            "c2ln",
        ].join(".");

    it("reads the status_list reference", () => {
        expect(
            statusLists.getStatusEntryFromJwt(
                jwtWith({
                    status: {
                        status_list: { uri: "https://wp.example/s", idx: 4 },
                    },
                }),
            ),
        ).toEqual({ uri: "https://wp.example/s", idx: 4 });
    });

    it.each([
        { case: "no status claim", payload: {} },
        {
            case: "a status claim of another mechanism",
            payload: { status: { identifier_list: { id: "1", uri: "x" } } },
        },
    ])("returns undefined for $case", ({ payload }) => {
        expect(
            statusLists.getStatusEntryFromJwt(jwtWith(payload)),
        ).toBeUndefined();
    });

    it.each([
        { case: "a status claim that is a string", status: "revoked" },
        { case: "a status claim that is an array", status: [] },
        { case: "a status claim that is null", status: null },
        { case: "a status claim without a mechanism", status: {} },
        {
            case: "an idx beyond the safe integers",
            status: { status_list: { uri: "https://s", idx: 2 ** 53 } },
        },
        {
            case: "an empty uri",
            status: { status_list: { uri: "", idx: 1 } },
        },
        { case: "a status_list that is null", status: { status_list: null } },
        { case: "no uri", status: { status_list: { idx: 1 } } },
        {
            case: "a uri that is not a string",
            status: { status_list: { uri: 1, idx: 1 } },
        },
        { case: "no idx", status: { status_list: { uri: "https://s" } } },
        {
            case: "an idx that is a string",
            status: { status_list: { uri: "https://s", idx: "1" } },
        },
        {
            case: "a negative idx",
            status: { status_list: { uri: "https://s", idx: -1 } },
        },
        {
            case: "a fractional idx",
            status: { status_list: { uri: "https://s", idx: 1.5 } },
        },
    ])("throws for $case", ({ status }) => {
        expect(() =>
            statusLists.getStatusEntryFromJwt(jwtWith({ status })),
        ).toThrow();
    });

    it("throws for a token that cannot be decoded", () => {
        expect(() => statusLists.getStatusEntryFromJwt("not-a-jwt")).toThrow();
    });
});
