import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { OpenIdFederationResolver } from "./adapters/openid-federation-resolver.js";
import { isStatusListUnavailableError } from "./revocation-policy.util.js";
import { StatusListVerifierService } from "./status-list-verifier.service.js";
import { TrustFetchService } from "./trust-fetch.service.js";
import { TrustListJwtService } from "./trustlist-jwt.service.js";

/**
 * Real requests against a local server: trust lists, status lists and
 * federation entity configurations go through the outbound URL policy, and
 * only EUDIPLO's own origins are exempt.
 */
describe("TrustFetchService", () => {
    let server: Server;
    let localhost: string;
    let loopbackIp: string;
    let requests: string[];

    beforeAll(async () => {
        server = createServer((request, response) => {
            requests.push(request.url ?? "");
            if (request.url === "/redirect") {
                response.writeHead(302, { location: `${loopbackIp}/ok` });
                response.end();
                return;
            }
            if (request.url === "/missing") {
                response.writeHead(404);
                response.end();
                return;
            }
            response.end("eyJhbGciOiJFUzI1NiJ9.e30.c2ln");
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        localhost = `http://localhost:${port}`;
        loopbackIp = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
    });

    /** Policy with the 9.0 defaults: HTTPS only, no private addresses. */
    const policy = (config: Record<string, boolean> = {}) =>
        new OutboundUrlPolicyService({
            get: vi.fn(
                (key: string, fallback?: unknown) => config[key] ?? fallback,
            ),
        } as never);

    const fetcher = (
        settings: { publicUrl: string; internalUrl?: string },
        outboundUrlPolicy = policy(),
    ) => new TrustFetchService(outboundUrlPolicy, settings);

    const options = { timeoutMs: 2000, maxBytes: 1024 };

    it("applies the outbound URL policy to other hosts", async () => {
        const trustFetch = fetcher({ publicUrl: "https://eudiplo.example" });

        await expect(
            trustFetch.get(`${loopbackIp}/ok`, options),
        ).rejects.toThrow("must use HTTPS");
        await expect(
            fetcher(
                { publicUrl: "https://eudiplo.example" },
                policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
            ).get(`${loopbackIp}/ok`, options),
        ).rejects.toThrow("private or loopback IP");
        expect(requests).toEqual([]);
    });

    it("exempts EUDIPLO's own PUBLIC_URL and INTERNAL_URL", async () => {
        await expect(
            fetcher({ publicUrl: `${localhost}/` }).get(
                `${localhost}/ok`,
                options,
            ),
        ).resolves.toMatchObject({ status: 200 });
        await expect(
            fetcher({
                publicUrl: "https://eudiplo.example",
                internalUrl: localhost,
            }).get(`${localhost}/ok`, options),
        ).resolves.toMatchObject({ status: 200 });
        expect(requests).toEqual(["/ok", "/ok"]);
    });

    it("checks a redirect from its own origin to another host", async () => {
        await expect(
            fetcher(
                {
                    publicUrl: "https://eudiplo.example",
                    internalUrl: localhost,
                },
                policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
            ).get(`${localhost}/redirect`, options),
        ).rejects.toThrow("private or loopback IP");
        expect(requests).toEqual(["/redirect"]);
    });

    it("rejects non-2xx responses", async () => {
        await expect(
            fetcher({ publicUrl: localhost }).get(
                `${localhost}/missing`,
                options,
            ),
        ).rejects.toThrow("Request failed with status code 404");
    });

    it("verifies TLS certificates only in production, as before", async () => {
        const outboundUrlPolicy = policy();
        const getFollowingRedirects = vi
            .spyOn(outboundUrlPolicy, "getFollowingRedirects")
            .mockResolvedValue({
                status: 200,
                body: "",
                bytes: Buffer.alloc(0),
                url: "https://lists.example/list",
            });
        const trustFetch = fetcher(
            { publicUrl: "https://eudiplo.example" },
            outboundUrlPolicy,
        );

        vi.stubEnv("NODE_ENV", "production");
        await trustFetch.get("https://lists.example/list", options);
        vi.stubEnv("NODE_ENV", "development");
        await trustFetch.get("https://lists.example/list", options);
        vi.unstubAllEnvs();

        expect(
            getFollowingRedirects.mock.calls.map(
                ([, call]) => call.rejectUnauthorized,
            ),
        ).toEqual([true, false]);
    });

    describe("callers", () => {
        const trustFetch = () =>
            fetcher({ publicUrl: "https://eudiplo.example" });

        it("does not fetch a status list from a private address named in a credential", async () => {
            const statusLists = new StatusListVerifierService(trustFetch());

            const error = await statusLists
                .getStatusListJwt(`${loopbackIp}/status/1`)
                .catch((e: unknown) => e);

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain(
                "Failed to fetch status list",
            );
            // The best-effort revocation policy treats it as unavailable.
            expect(isStatusListUnavailableError(error)).toBe(true);
            expect(requests).toEqual([]);
        });

        it("does not fetch a trust list from a private address", async () => {
            await expect(
                new TrustListJwtService(trustFetch()).fetchJwt(
                    `${loopbackIp}/trust-list`,
                ),
            ).rejects.toThrow("Failed to fetch trust list");
            expect(requests).toEqual([]);
        });

        it("still fetches a managed trust list from INTERNAL_URL", async () => {
            const trustLists = new TrustListJwtService(
                fetcher({
                    publicUrl: "https://eudiplo.example",
                    internalUrl: localhost,
                }),
            );

            await expect(
                trustLists.fetchJwt(
                    `${localhost}/issuers/tenant/trust-list/list`,
                ),
            ).resolves.toBe("eyJhbGciOiJFUzI1NiJ9.e30.c2ln");
        });

        it("does not resolve a federation entity on a private address", async () => {
            // The entity ID comes from the presented certificate's SAN.
            await expect(
                new OpenIdFederationResolver(
                    trustFetch(),
                ).resolveEntityConfiguration(loopbackIp),
            ).rejects.toThrow("must use HTTPS");
            expect(requests).toEqual([]);
        });
    });
});
