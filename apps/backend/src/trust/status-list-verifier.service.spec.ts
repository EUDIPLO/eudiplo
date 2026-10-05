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
import { StatusListVerifierService } from "./status-list-verifier.service.js";
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
        claims: { ttl?: number; exp?: number },
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
            name: "parsed status lists",
            token: (claims: { ttl?: number; exp?: number }) =>
                Promise.resolve(jwt(claims)),
            get: (statusLists: StatusListVerifierService, uri: string) =>
                statusLists.getStatusList(uri),
        },
        {
            name: "status list JWTs",
            token: (claims: { ttl?: number; exp?: number }) =>
                Promise.resolve(jwt(claims)),
            get: (statusLists: StatusListVerifierService, uri: string) =>
                statusLists.getStatusListJwt(uri),
        },
        {
            name: "status list CWTs",
            token: cwt,
            get: (statusLists: StatusListVerifierService, uri: string) =>
                statusLists.getStatusListCwt(uri),
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
            await statusLists.getStatusListJwt(`${origin}/list/${i}`);
        }
        await statusLists.getStatusListJwt(`${origin}/list/0`);
        requests = [];

        await statusLists.getStatusListJwt(`${origin}/list/1000`);

        const { jwtCacheSize, uris } = statusLists.getCacheStats();
        expect(jwtCacheSize).toBe(1000);
        expect(uris).toContain(`${origin}/list/0`);
        expect(uris).not.toContain(`${origin}/list/1`);
        await statusLists.getStatusListJwt(`${origin}/list/0`);
        await statusLists.getStatusListJwt(`${origin}/list/1`);
        expect(requests).toEqual(["/list/1000", "/list/1"]);
    }, 30_000);

    it("bounds parsed status lists by their number of statuses", async () => {
        // A few hundred bytes of token, three million statuses (~24 MB) each:
        // the 64 MiB budget holds two of them.
        const lst = deflateSync(new Uint8Array(375_000));
        for (const path of ["/big/1", "/big/2", "/big/3"]) {
            tokens.set(path, jwt({ ttl: 600 }, lst));
        }
        const statusLists = service();

        for (const path of ["/big/1", "/big/2", "/big/3"]) {
            await statusLists.getStatusList(`${origin}${path}`);
        }

        expect(statusLists.getCacheStats()).toMatchObject({
            size: 2,
            uris: [`${origin}/big/2`, `${origin}/big/3`],
        });
    }, 30_000);

    it("clears one or all status lists", async () => {
        const statusLists = service();
        await statusLists.getStatusList(`${origin}/a`);
        await statusLists.getStatusListJwt(`${origin}/a`);
        await statusLists.getStatusListJwt(`${origin}/b`);
        tokens.set("/c", await cwt({}));
        await statusLists.getStatusListCwt(`${origin}/c`);

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
});
