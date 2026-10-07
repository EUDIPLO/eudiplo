import { describe, expect, it } from "vitest";
import { requestAccessToken } from "../src/services/api-auth.js";
import {
    compareVersions,
    readBackendVersion,
    readProviderHealth,
    summarizeProviderHealth,
} from "../src/services/backend-checks.js";
import { hasFailedChecks, runDoctor } from "../src/services/diagnostics.js";
import type { CommandContext, DoctorCheck } from "../src/types.js";
import packageJson from "../package.json" with { type: "json" };

const instance = {
    target: "external",
    url: "https://eudiplo.example.com",
} as const;

const credentials = {
    EUDIPLO_CLIENT_ID: "root",
    EUDIPLO_CLIENT_SECRET: "super-secret-value",
};

interface Route {
    status?: number;
    body?: unknown;
}

function createContext(
    routes: Record<string, Route>,
    env: Record<string, string> = {},
) {
    const requests: { url: string; authorization?: string; body?: string }[] =
        [];
    const context: CommandContext = {
        cwd: "/",
        env,
        readCertificate: async () => ({
            subject: "eudiplo.example.com",
            issuer: "Example CA",
            validTo: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        }),
        stdout: { write: () => true },
        stderr: { write: () => true },
        fetch: async (input, init) => {
            const url = input instanceof URL ? input : new URL(String(input));
            requests.push({
                url: url.pathname,
                authorization:
                    new Headers(init?.headers).get("authorization") ??
                    undefined,
                body: typeof init?.body === "string" ? init.body : undefined,
            });
            // Like the backend, unknown paths are not found, so a wrong
            // path shows up as a skipped check instead of passing.
            const route = routes[url.pathname] ?? { status: 404, body: {} };
            return new Response(JSON.stringify(route.body ?? {}), {
                status: route.status ?? 200,
            });
        },
    };
    return { context, requests };
}

function find(checks: DoctorCheck[], name: string): DoctorCheck {
    const check = checks.find((entry) => entry.name === name);
    if (!check) {
        throw new Error(`no check named ${name}`);
    }
    return check;
}

describe("client credentials token", () => {
    it("reports unavailable when credentials are not configured", async () => {
        const { context, requests } = createContext({});

        expect(
            await requestAccessToken(new URL(instance.url), context),
        ).toMatchObject({ kind: "unavailable" });
        expect(requests).toHaveLength(0);
    });

    it("posts the client credentials grant and returns the token", async () => {
        const { context, requests } = createContext(
            {
                "/api/oauth2/token": { body: { access_token: "token-123" } },
            },
            credentials,
        );

        expect(
            await requestAccessToken(new URL(instance.url), context),
        ).toEqual({ kind: "token", accessToken: "token-123" });
        expect(requests[0].url).toBe("/api/oauth2/token");
        expect(requests[0].body).toContain("grant_type=client_credentials");
    });

    it("reports the status code only, never the response body", async () => {
        const { context } = createContext(
            {
                "/api/oauth2/token": {
                    status: 401,
                    body: { error: "invalid_client super-secret-value" },
                },
            },
            credentials,
        );

        const result = await requestAccessToken(new URL(instance.url), context);
        expect(result).toEqual({
            kind: "error",
            reason: "the token endpoint returned HTTP 401",
        });
    });
});

describe("version compatibility", () => {
    it("passes on the same major.minor", () => {
        expect(compareVersions("8.1.3", "8.1.0").status).toBe("pass");
    });

    it("warns on a minor difference", () => {
        const check = compareVersions("8.0.2", "8.1.0");
        expect(check.status).toBe("warn");
        expect(check.message).toContain("minor version");
    });

    it("fails on a major difference and says how to fix it", () => {
        const check = compareVersions("7.4.0", "8.1.0");
        expect(check.status).toBe("fail");
        expect(check.message).toContain("@eudiplo/cli@8");
    });

    it("warns when a version cannot be parsed, such as a dev build", () => {
        expect(compareVersions("8.1.0", "main").status).toBe("warn");
    });

    it("reads the backend version defensively", () => {
        expect(readBackendVersion({ version: "8.1.0" })).toBe("8.1.0");
        expect(readBackendVersion({})).toBeUndefined();
        expect(readBackendVersion(null)).toBeUndefined();
    });
});

describe("KMS provider health", () => {
    it("passes and reports latency per provider", () => {
        const check = summarizeProviderHealth(
            readProviderHealth([
                { providerId: "db", type: "database", ok: true, latencyMs: 4 },
                { providerId: "vault", type: "vault", ok: true, latencyMs: 12 },
            ]),
        );
        expect(check.status).toBe("pass");
        expect(check.message).toContain("db (database, 4ms)");
    });

    it("fails without echoing the provider error text", () => {
        const check = summarizeProviderHealth(
            readProviderHealth([
                { providerId: "db", type: "database", ok: true },
                {
                    providerId: "vault",
                    type: "vault",
                    ok: false,
                    error: "token s.abcdef expired at https://vault.internal",
                },
            ]),
        );
        expect(check.status).toBe("fail");
        expect(check.message).toContain("vault (vault)");
        expect(check.message).not.toContain("s.abcdef");
        expect(check.message).not.toContain("vault.internal");
    });

    it("warns when no providers are registered", () => {
        expect(summarizeProviderHealth([]).status).toBe("warn");
    });

    it("rejects a response that is not a list", () => {
        expect(() => readProviderHealth({})).toThrow();
    });
});

describe("authenticated doctor checks", () => {
    it("skips them when no credentials are configured", async () => {
        const { context, requests } = createContext({});
        const checks = await runDoctor(instance, context, []);

        expect(find(checks, "version compatibility").status).toBe("skip");
        expect(find(checks, "KMS providers").status).toBe("skip");
        expect(requests.some((request) => request.url.includes("token"))).toBe(
            false,
        );
    });

    it("runs them with credentials, reusing one token", async () => {
        const { context, requests } = createContext(
            {
                "/api/oauth2/token": { body: { access_token: "token-123" } },
                "/api/version": { body: { version: packageJson.version } },
                "/api/key-chain/providers/health": {
                    body: [
                        {
                            providerId: "db",
                            type: "database",
                            ok: true,
                            latencyMs: 3,
                        },
                    ],
                },
            },
            credentials,
        );

        const checks = await runDoctor(instance, context, []);

        expect(find(checks, "version compatibility").status).toBe("pass");
        expect(find(checks, "KMS providers").status).toBe("pass");
        expect(
            requests.filter((request) => request.url.includes("token")),
        ).toHaveLength(1);
        expect(
            requests
                .filter((request) => request.authorization)
                .map((request) => [request.url, request.authorization]),
        ).toEqual([
            ["/api/version", "Bearer token-123"],
            ["/api/key-chain/providers/health", "Bearer token-123"],
        ]);
    });

    it("keeps a path prefix of the instance URL for every request", async () => {
        const { context, requests } = createContext(
            {
                "/eudiplo/api/oauth2/token": {
                    body: { access_token: "token-123" },
                },
                "/eudiplo/api/version": {
                    body: { version: packageJson.version },
                },
                "/eudiplo/api/key-chain/providers/health": { body: [] },
                "/eudiplo/api/docs": {},
                "/eudiplo/health": {},
                "/console/": {},
            },
            credentials,
        );

        const checks = await runDoctor(
            {
                ...instance,
                url: "https://eudiplo.example.com/eudiplo",
                clientUrl: "https://eudiplo.example.com/console",
            },
            context,
            [],
        );

        expect(requests.map((request) => request.url).sort()).toEqual([
            "/console/",
            "/eudiplo/api/docs",
            "/eudiplo/api/key-chain/providers/health",
            "/eudiplo/api/oauth2/token",
            "/eudiplo/api/version",
            "/eudiplo/health",
        ]);
        expect(find(checks, "API reachability").status).toBe("pass");
        expect(find(checks, "health endpoint").status).toBe("pass");
        expect(find(checks, "version compatibility").status).toBe("pass");
        expect(find(checks, "client connectivity").status).toBe("pass");
    });

    it("skips when the backend is too old to have the endpoints", async () => {
        const { context } = createContext(
            {
                "/api/oauth2/token": { body: { access_token: "token-123" } },
                "/api/version": { status: 404 },
                "/api/key-chain/providers/health": { status: 404 },
            },
            credentials,
        );

        const checks = await runDoctor(instance, context, []);

        expect(find(checks, "version compatibility")).toMatchObject({
            status: "skip",
            message: expect.stringContaining("/api/version"),
        });
        expect(find(checks, "KMS providers").status).toBe("skip");
    });

    it("skips only the KMS check on a backend without provider health", async () => {
        const { context } = createContext(
            {
                "/api/oauth2/token": { body: { access_token: "token-123" } },
                "/api/version": { body: { version: packageJson.version } },
            },
            credentials,
        );

        const checks = await runDoctor(instance, context, []);

        expect(find(checks, "version compatibility").status).toBe("pass");
        expect(find(checks, "KMS providers").status).toBe("skip");
    });

    it.each([401, 403])(
        "skips the KMS check for a client without a tenant role (HTTP %i)",
        async (status) => {
            // The bootstrap root client has tenants:manage and no tenant, so
            // the backend refuses the per-tenant provider health.
            const { context } = createContext(
                {
                    "/api/oauth2/token": {
                        body: { access_token: "token-123" },
                    },
                    "/api/version": { body: { version: packageJson.version } },
                    "/api/key-chain/providers/health": { status },
                    "/api/docs": {},
                    "/health": {},
                },
                credentials,
            );

            const checks = await runDoctor(instance, context, []);

            expect(find(checks, "KMS providers")).toEqual({
                name: "KMS providers",
                status: "skip",
                message: `Needs a tenant client with issuance:manage or presentation:manage (/api/key-chain/providers/health returned HTTP ${status}).`,
            });
            // Every other check passes, so --strict passes as well.
            expect(hasFailedChecks(checks, true)).toBe(false);
        },
    );

    it("fails when the endpoints error for another reason", async () => {
        const { context } = createContext(
            {
                "/api/oauth2/token": { body: { access_token: "token-123" } },
                "/api/version": { status: 500 },
                "/api/key-chain/providers/health": { status: 500 },
            },
            credentials,
        );

        const checks = await runDoctor(instance, context, []);

        expect(find(checks, "version compatibility").status).toBe("fail");
        expect(find(checks, "KMS providers").status).toBe("fail");
    });

    it("fails, rather than skipping, when the credentials are rejected", async () => {
        const { context } = createContext(
            { "/api/oauth2/token": { status: 401 } },
            credentials,
        );

        const checks = await runDoctor(instance, context, []);
        expect(find(checks, "version compatibility").status).toBe("fail");
        expect(find(checks, "version compatibility").message).toContain(
            "HTTP 401",
        );
    });

    it("never prints the client secret in any check message", async () => {
        const { context } = createContext(
            { "/api/oauth2/token": { status: 500 } },
            credentials,
        );

        const checks = await runDoctor(instance, context, []);
        for (const check of checks) {
            expect(check.message).not.toContain("super-secret-value");
        }
    });
});
