import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { secretSourceContract } from "../../../../test/secrets/secret-source.contract.js";
import { reference } from "../../../../test/secrets/secret-test-sources.js";
import {
    type VaultAuth,
    VaultSecretSource,
    VaultUnavailableError,
    type VaultSecretSourceSettings,
} from "./vault-secret-source.js";

/** A fake Vault: KV v2 at `kv`, KV v1 at `old`, tokens and AppRole. */
class FakeVault {
    kv2 = new Map<string, Record<string, unknown>[]>([
        [
            "eudiplo/tenants/acme/shop",
            [{ token: "v1-token" }, { token: "v2-token", other: 5 }],
        ],
        ["a:b/c", [{ key: "colon-path" }]],
    ]);
    kv1 = new Map<string, Record<string, unknown>>([
        ["legacy/app", { password: "legacy-pass" }],
    ]);
    tokens = new Set(["root", "approle-1"]);
    /** Paths a token may not read. */
    forbidden = new Set<string>(["kv/data/eudiplo/forbidden"]);
    logins = 0;
    down = false;
    /** Answers to give instead, by path. */
    answers = new Map<string, Response>();
    /** Whether tokens may look themselves up (the default policy). */
    lookupAllowed = true;
    requests: { url: string; init: RequestInit }[] = [];
    leaseSeconds = 3600;

    fetch = async (url: string, init: RequestInit): Promise<Response> => {
        this.requests.push({ url, init });
        if (this.down) throw new TypeError("fetch failed");
        const { pathname, searchParams } = new URL(url);
        const answer = this.answers.get(pathname);
        if (answer) return answer.clone();
        const json = (status: number, body: unknown = {}) =>
            new Response(JSON.stringify(body), { status });
        if (/^\/v1\/auth\/[^/]+\/login$/.test(pathname)) {
            const body = JSON.parse(String(init.body));
            if (body.role_id !== "role" || body.secret_id !== "secret")
                return json(400, { errors: ["invalid role or secret ID"] });
            this.logins++;
            const token = `approle-${this.logins}`;
            this.tokens.add(token);
            return json(200, {
                auth: {
                    client_token: token,
                    lease_duration: this.leaseSeconds,
                },
            });
        }
        const token = (init.headers as Record<string, string>)["X-Vault-Token"];
        if (!this.tokens.has(token))
            return json(403, { errors: ["permission denied"] });
        if (pathname === "/v1/auth/token/lookup-self")
            return this.lookupAllowed
                ? json(200, { data: { id: token } })
                : json(403, { errors: ["permission denied"] });
        const kv2 = pathname.match(/^\/v1\/kv\/data\/(.+)$/);
        if (kv2) {
            const path = decodeURIComponent(kv2[1]);
            if (this.forbidden.has(`kv/data/${path}`))
                return json(403, { errors: ["permission denied"] });
            const versions = this.kv2.get(path);
            const version = Number(
                searchParams.get("version") ?? versions?.length,
            );
            const data = versions?.[version - 1];
            return data
                ? json(200, { data: { data, metadata: { version } } })
                : json(404, { errors: [] });
        }
        const kv1 = pathname.match(/^\/v1\/old\/(.+)$/);
        if (kv1) {
            const data = this.kv1.get(decodeURIComponent(kv1[1]));
            return data ? json(200, { data }) : json(404, { errors: [] });
        }
        return json(404, { errors: [] });
    };
}

const MOUNTS: VaultSecretSourceSettings["mounts"] = {
    kv: { version: 2 },
    old: { version: 1 },
};

describe("VaultSecretSource", () => {
    let vault: FakeVault;
    let now: number;
    const signal = () => new AbortController().signal;
    const source = (auth: VaultAuth = { method: "token", token: "root" }) =>
        new VaultSecretSource(
            { address: "https://vault.example/", auth, mounts: MOUNTS },
            vault.fetch,
            () => now,
        );
    const read = (text: string, from = source()) =>
        from.read(reference(text), signal()).then((value) => value?.reveal());

    beforeEach(() => {
        vault = new FakeVault();
        now = 0;
    });

    it("reads keys of KV v2 secrets, also a pinned version", async () => {
        expect(await read("${vault:kv/eudiplo/tenants/acme/shop#token}")).toBe(
            "v2-token",
        );
        expect(
            await read("${vault:kv/eudiplo/tenants/acme/shop#token@1}"),
        ).toBe("v1-token");
        expect(await read("${vault:kv/a:b/c#key}")).toBe("colon-path");
        expect(vault.requests.map((request) => request.url)).toEqual([
            "https://vault.example/v1/kv/data/eudiplo/tenants/acme/shop",
            "https://vault.example/v1/kv/data/eudiplo/tenants/acme/shop?version=1",
            "https://vault.example/v1/kv/data/a%3Ab/c",
        ]);
    });

    it("reads keys of KV v1 secrets", async () => {
        expect(await read("${vault:old/legacy/app#password}")).toBe(
            "legacy-pass",
        );
        expect(vault.requests[0].url).toBe(
            "https://vault.example/v1/old/legacy/app",
        );
    });

    it("answers undefined for what Vault does not hold or this path may not read", async () => {
        for (const text of [
            "${vault:kv/eudiplo/tenants/acme/shop#missing}",
            "${vault:kv/eudiplo/tenants/acme/shop#other}",
            "${vault:kv/eudiplo/tenants/acme/shop#token@9}",
            "${vault:kv/eudiplo/none#token}",
            "${vault:kv/eudiplo/forbidden#token}",
            "${vault:old/legacy/none#password}",
        ])
            expect(await read(text), text).toBeUndefined();
    });

    it("never asks Vault for a mount it does not list", async () => {
        const from = source();
        // A version of a KV v1 mount, which keeps none, is not asked for.
        expect(
            await read("${vault:old/legacy/app#password@2}", from),
        ).toBeUndefined();
        for (const text of [
            "${vault:sys/policy#x}",
            "${vault:transit/keys#x}",
        ]) {
            expect(from.refusal(reference(text), "instance")).toMatch(
                /no KV mount this instance lists/,
            );
            expect(await read(text, from)).toBeUndefined();
        }
        expect(
            from.refusal(
                reference("${vault:old/legacy/app#password@2}"),
                "tenant",
            ),
        ).toMatch(/keeps no versions/);
        expect(vault.requests).toEqual([]);
    });

    it("sends its token only to Vault, without following redirects", async () => {
        await read("${vault:kv/eudiplo/tenants/acme/shop#token}");
        expect(vault.requests[0].init).toMatchObject({
            method: "GET",
            redirect: "error",
            headers: { "X-Vault-Token": "root" },
        });
        expect(vault.requests[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it("sends the namespace of Vault Enterprise", async () => {
        await new VaultSecretSource(
            {
                address: "https://vault.example",
                auth: { method: "token", token: "root" },
                mounts: MOUNTS,
                namespace: "eudiplo",
            },
            vault.fetch,
        ).read(reference("${vault:kv/a:b/c#key}"), signal());
        expect(vault.requests[0].init.headers).toMatchObject({
            "X-Vault-Namespace": "eudiplo",
        });
    });

    it("is unavailable when Vault cannot be reached or refuses its token", async () => {
        vault.down = true;
        await expect(read("${vault:kv/a:b/c#key}")).rejects.toThrow(
            "Vault cannot be reached",
        );
        vault.down = false;
        vault.tokens.delete("root");
        await expect(read("${vault:kv/a:b/c#key}")).rejects.toThrow(
            "Vault refuses the token of this instance",
        );
    });

    it("logs in with AppRole once, and again before the lease ends", async () => {
        const auth: VaultAuth = {
            method: "approle",
            roleId: "role",
            secretId: "secret",
        };
        const from = source(auth);
        await Promise.all([
            read("${vault:kv/a:b/c#key}", from),
            read("${vault:kv/a:b/c#key}", from),
        ]);
        expect(vault.logins).toBe(1);
        now = 3_600_000 - 30_000;
        expect(await read("${vault:kv/a:b/c#key}", from)).toBe("colon-path");
        expect(vault.logins).toBe(2);
        const login = vault.requests.find((request) =>
            request.url.endsWith("/v1/auth/approle/login"),
        );
        expect(login?.init).toMatchObject({
            method: "POST",
            redirect: "error",
        });
    });

    it("logs in again when Vault refuses an AppRole token early", async () => {
        const from = source({
            method: "approle",
            roleId: "role",
            secretId: "secret",
        });
        await read("${vault:kv/a:b/c#key}", from);
        vault.tokens.delete("approle-1");
        // Right after a login, a refused token is not replaced yet.
        await expect(read("${vault:kv/a:b/c#key}", from)).rejects.toThrow(
            "Vault refuses the token of this instance",
        );
        now = 30_000;
        expect(await read("${vault:kv/a:b/c#key}", from)).toBe("colon-path");
        expect(vault.logins).toBe(2);
    });

    it("does not log in again for a path the AppRole token may not read", async () => {
        const from = source({
            method: "approle",
            roleId: "role",
            secretId: "secret",
        });
        for (let i = 0; i < 3; i++)
            expect(
                await read("${vault:kv/eudiplo/forbidden#token}", from),
            ).toBeUndefined();
        expect(vault.logins).toBe(1);
    });

    it("logs in again at most once per interval, also when tokens may not look themselves up", async () => {
        vault.lookupAllowed = false;
        const from = source({
            method: "approle",
            roleId: "role",
            secretId: "secret",
        });
        const forbidden = "${vault:kv/eudiplo/forbidden#token}";
        await expect(read(forbidden, from)).rejects.toThrow(
            /refuses the token/,
        );
        now = 30_000;
        for (let i = 0; i < 5; i++) await read(forbidden, from).catch(() => {});
        expect(vault.logins).toBe(2);
    });

    it("logs in at a custom AppRole mount, and keeps a token without lease", async () => {
        vault.leaseSeconds = 0;
        const from = source({
            method: "approle",
            roleId: "role",
            secretId: "secret",
            mount: "eudiplo-ar",
        });
        await read("${vault:kv/a:b/c#key}", from);
        now = 10 * 365 * 24 * 3_600_000;
        await read("${vault:kv/a:b/c#key}", from);
        expect(vault.logins).toBe(1);
        expect(vault.requests[0].url).toBe(
            "https://vault.example/v1/auth/eudiplo-ar/login",
        );
    });

    it("is unavailable when Vault fails or answers with no JSON, so cached values serve", async () => {
        const path = "/v1/kv/data/a%3Ab/c";
        for (const [response, message] of [
            [new Response("sealed", { status: 503 }), "Vault answered 503"],
            [new Response("", { status: 500 }), "Vault answered 500"],
            [new Response("", { status: 429 }), "Vault answered 429"],
            [
                new Response("<html>proxy</html>", { status: 200 }),
                "Vault answered with no JSON object",
            ],
            [
                new Response("null", { status: 200 }),
                "Vault answered with no JSON object",
            ],
            [
                new Response(`{"data":"${"x".repeat(300_000)}"}`, {
                    status: 200,
                }),
                "Vault answered with more than 262144 bytes",
            ],
            [
                new Response("{}", {
                    status: 200,
                    headers: { "content-length": "10000000" },
                }),
                "Vault answered with more than 262144 bytes",
            ],
        ] as const) {
            vault.answers.set(path, response);
            const failure = read("${vault:kv/a:b/c#key}");
            await expect(failure, message).rejects.toThrow(message);
            await expect(failure).rejects.toBeInstanceOf(VaultUnavailableError);
        }
    });

    it("takes a lookup answered with 401 for a refused token", async () => {
        vault.answers.set(
            "/v1/auth/token/lookup-self",
            new Response("", { status: 401 }),
        );
        await expect(
            read("${vault:kv/eudiplo/forbidden#token}"),
        ).rejects.toThrow("Vault refuses the token of this instance");
    });

    it("lets a read reuse the token another read logged in for", async () => {
        const from = source({
            method: "approle",
            roleId: "role",
            secretId: "secret",
        });
        await read("${vault:kv/a:b/c#key}", from);
        vault.tokens.delete("approle-1");
        now = 30_000;
        expect(
            await Promise.all([
                read("${vault:kv/a:b/c#key}", from),
                read("${vault:kv/a:b/c#key}", from),
            ]),
        ).toEqual(["colon-path", "colon-path"]);
        expect(vault.logins).toBe(2);
    });

    it("is unavailable when the AppRole login cannot be done", async () => {
        const approle: VaultAuth = {
            method: "approle",
            roleId: "role",
            secretId: "secret",
        };
        vault.down = true;
        await expect(
            read("${vault:kv/a:b/c#key}", source(approle)),
        ).rejects.toThrow("Vault cannot be reached");
        vault.down = false;
        vault.answers.set(
            "/v1/auth/approle/login",
            new Response("<html/>", { status: 200 }),
        );
        await expect(
            read("${vault:kv/a:b/c#key}", source(approle)),
        ).rejects.toThrow(/refuses the AppRole login of this instance \(200\)/);
        vault.answers.set(
            "/v1/auth/approle/login",
            new Response("{}", { status: 200 }),
        );
        await expect(
            read("${vault:kv/a:b/c#key}", source(approle)),
        ).rejects.toThrow(/\(200\)/);
        expect(vault.logins).toBe(0);
    });

    it("is unavailable when a token lookup fails after a 403", async () => {
        vault.answers.set(
            "/v1/auth/token/lookup-self",
            new Response("", { status: 503 }),
        );
        await expect(
            read("${vault:kv/eudiplo/forbidden#token}"),
        ).rejects.toThrow("Vault answered 503 to a token lookup");
    });

    it("answers undefined for a 400 and an empty value", async () => {
        vault.kv2.set("empty", [{ key: "" }]);
        expect(await read("${vault:kv/empty#key}")).toBeUndefined();
        vault.answers.set(
            "/v1/kv/data/a%3Ab/c",
            new Response("{}", { status: 400 }),
        );
        expect(await read("${vault:kv/a:b/c#key}")).toBeUndefined();
    });

    it("refuses addresses that would send the token unencrypted", () => {
        const create = (address: string, allowHttp?: boolean) =>
            new VaultSecretSource({
                address,
                auth: { method: "token", token: "root" },
                mounts: MOUNTS,
                allowHttp,
            });
        expect(() => create("http://vault.example:8200")).toThrow(/uses http:/);
        expect(() => create("ftp://vault.example")).toThrow(/no http\(s\) URL/);
        expect(() => create("not a url")).toThrow();
        for (const address of [
            "https://vault.example",
            "http://localhost:8200",
            "http://127.0.0.1:8200",
            "http://[::1]:8200",
        ])
            expect(() => create(address), address).not.toThrow();
        expect(() => create("http://vault:8200", true)).not.toThrow();
    });

    it("is unavailable when the AppRole login fails, without naming its credentials", async () => {
        const from = source({
            method: "approle",
            roleId: "role",
            secretId: "wrong-secret-id",
        });
        const error = await read("${vault:kv/a:b/c#key}", from).catch((e) => e);
        expect(String(error)).toMatch(/refuses the AppRole login .*\(400\)/);
        expect(inspect(error, { depth: 10 })).not.toContain("wrong-secret-id");
    });

    it("validates grant patterns", () => {
        const from = source();
        for (const pattern of [
            "kv/",
            "kv/eudiplo/tenants/",
            "kv/eudiplo/tenants/{tenant}/",
            "kv/operator/csc",
            "kv/operator/csc#clientSecret",
            "kv/t/{tenant}#token",
            "old/legacy/",
        ])
            expect(from.validatePattern(pattern), pattern).toBeUndefined();
        const refused: Array<[string, RegExp]> = [
            ["kv", /names a mount and a path/],
            ["kv/a/#x", /path ending in \/, a secret, or a secret#key/],
            ["kv/a#b/c", /key after #/],
            ["kv/../x/", /no empty, \. or \.\. segment/],
            ["kv//x/", /no empty/],
            ["kv/t-{tenant}/", /whole path segment/],
            ["{tenant}/x/", /cannot be the mount/],
            ["sys/", /no KV mount/],
            ["kv/a b/", /segments of/],
        ];
        for (const [pattern, message] of refused)
            expect(from.validatePattern(pattern), pattern).toMatch(message);
    });

    it("matches references against prefixes, secrets and keys", () => {
        const from = source();
        const ref = reference("${vault:kv/eudiplo/tenants/acme/shop#token@2}");
        expect(from.within(ref, "kv/eudiplo/tenants/")).toBe(true);
        expect(from.within(ref, "kv/eudiplo/tenants/acme/shop")).toBe(true);
        expect(from.within(ref, "kv/eudiplo/tenants/acme/shop#token")).toBe(
            true,
        );
        expect(from.within(ref, "kv/eudiplo/tenants/acme/shop#other")).toBe(
            false,
        );
        expect(from.within(ref, "kv/eudiplo/tenants/acme/sh")).toBe(false);
        expect(from.within(ref, "kv/eudiplo/tenants/acme-2/")).toBe(false);
        expect(from.within(ref, "kv/eudiplo/tenants/acme/shop/")).toBe(false);
    });
});

secretSourceContract("VaultSecretSource", () => {
    const vault = new FakeVault();
    return {
        source: new VaultSecretSource(
            {
                address: "https://vault.example",
                auth: { method: "token", token: "root" },
                mounts: MOUNTS,
            },
            vault.fetch,
        ),
        present: {
            reference: "${vault:kv/eudiplo/tenants/acme/shop#token}",
            value: "v2-token",
        },
        missing: "${vault:kv/eudiplo/tenants/acme/none#token}",
        patterns: [
            "kv/",
            "kv/eudiplo/",
            "kv/eudiplo/tenants/",
            "kv/eudiplo/tenants/acme/",
            "kv/eudiplo/tenants/acme-2/",
            "kv/eudiplo/tenants/acme/shop",
            "kv/eudiplo/tenants/acme/shop#token",
            "kv/eudiplo/tenants/acme/shop#other",
            "kv/eudiplo/tenants/acme/sh",
            "old/legacy/",
        ],
        references: [
            "${vault:kv/eudiplo/tenants/acme/shop#token}",
            "${vault:kv/eudiplo/tenants/acme/shop#other@3}",
            "${vault:kv/eudiplo/tenants/acme-2/shop#token}",
            "${vault:kv/eudiplo/tenants/acme/sh#token}",
            "${vault:kv/eudiplo/instance/db#password}",
            "${vault:old/legacy/app#password}",
        ],
    };
});
