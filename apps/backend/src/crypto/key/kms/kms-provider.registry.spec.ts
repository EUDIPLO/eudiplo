import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpService } from "@nestjs/axios";
import { Logger } from "@nestjs/common";
import { firstValueFrom } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import type { KmsConfig } from "../schemas/kms-config.schema.js";
import { AwsKmsAdapter } from "./adapters/aws-kms.adapter.js";
import {
    KmsProviderRegistry,
    RETIRED_ADAPTER_GRACE_MS,
} from "./kms-provider.registry.js";

describe("KmsProviderRegistry", () => {
    const vault = (id: string) =>
        ({
            id,
            type: "vault",
            vaultUrl: "https://vault.example",
            vaultToken: "token",
        }) as KmsConfig["providers"][number];
    const globalConfig: KmsConfig = {
        providers: [{ id: "db", type: "db" }, vault("global-vault")],
    };
    const globalHttp = {};
    const safeLookup = () => undefined;
    function setup() {
        let tenantConfig: KmsConfig = {
            providers: [{ id: "db", type: "db" }],
        };
        const tenantFile: KmsConfig = { providers: [] };
        const registry = new KmsProviderRegistry(
            {
                getConfig: (tenantId?: string) =>
                    tenantId ? tenantConfig : globalConfig,
                getTenantSnapshot: () => ({
                    config: tenantConfig,
                    file: tenantFile,
                }),
            } as never,
            globalHttp as never,
            { safeLookup } as never,
        );
        return {
            registry,
            /** As the configuration service does when the file changed. */
            replaceConfig: (config: KmsConfig) => {
                tenantConfig = config;
            },
        };
    }

    it("binds the requests of a tenant file's providers to the outbound URL policy, not those of global providers", () => {
        const { registry, replaceConfig } = setup();
        const own = [
            vault("own-vault"),
            { id: "own-http", type: "http", baseUrl: "https://kms.example" },
            {
                id: "own-csc",
                type: "csc",
                baseUrl: "https://csc.example",
                tokenUrl: "https://csc.example/token",
                clientId: "id",
                clientSecret: "secret",
            },
        ] as KmsConfig["providers"];
        // As mergeConfigs builds it: global providers as they are.
        replaceConfig({ providers: [...globalConfig.providers, ...own] });
        const httpOf = (id: string) =>
            (registry.resolve(id, "tenant") as any).http;

        expect(httpOf("global-vault")).toBe(globalHttp);
        for (const { id } of own) {
            expect(httpOf(id)).not.toBe(globalHttp);
            expect(httpOf(id).axiosRef.defaults).toMatchObject({
                lookup: safeLookup,
                httpAgent: false,
                httpsAgent: false,
                maxRedirects: 0,
                proxy: false,
                timeout: 30_000,
                maxContentLength: 1024 * 1024,
                maxBodyLength: 1024 * 1024,
            });
        }
    });

    describe("requests", () => {
        const servers: Server[] = [];
        /** A local server that counts its requests and answers with `reply`. */
        const listen = async (
            reply: (res: ServerResponse) => void = (res) => res.end("{}"),
        ) => {
            const started = { hits: 0, url: "" };
            const server = createServer((_req, res) => {
                started.hits++;
                reply(res);
            });
            servers.push(server);
            await new Promise<void>((resolve) =>
                server.listen(0, "127.0.0.1", resolve),
            );
            started.url = `http://localhost:${(server.address() as AddressInfo).port}`;
            return started;
        };
        /** A registry with one `http` provider in the global and one in the tenant file. */
        const registryFor = (
            baseUrl: string,
            settings: Record<string, string> = {},
        ) => {
            const shared = { id: "global", type: "http", baseUrl };
            const global = { providers: [shared] } as KmsConfig;
            const tenant = {
                providers: [shared, { id: "own", type: "http", baseUrl }],
            } as KmsConfig;
            return new KmsProviderRegistry(
                {
                    getConfig: (tenantId?: string) =>
                        tenantId ? tenant : global,
                } as never,
                new HttpService(),
                new OutboundUrlPolicyService({
                    get: (key: string, fallback?: unknown) =>
                        settings[key] ?? fallback,
                } as never),
            );
        };
        afterEach(() => {
            for (const server of servers.splice(0)) server.close();
        });

        it("do not reach a private address from a tenant file's provider, but from a global one", async () => {
            const kms = await listen();
            const registry = registryFor(kms.url);

            const health = await registry.health("tenant");

            expect(health).toContainEqual(
                expect.objectContaining({
                    providerId: "own",
                    ok: false,
                    error: expect.stringContaining("private or loopback"),
                }),
            );
            expect(health).toContainEqual(
                expect.objectContaining({ providerId: "global", ok: true }),
            );
            // Only the global provider's request arrived.
            expect(kms.hits).toBe(1);
        });

        it("end after the deadline when a tenant file's provider trickles its answer", async () => {
            const kms = await listen((res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.write(" ");
                const drip = setInterval(() => res.write(" "), 20);
                res.on("close", () => clearInterval(drip));
            });
            const deadline = AbortSignal.timeout.bind(AbortSignal);
            const timeout = vi
                .spyOn(AbortSignal, "timeout")
                .mockImplementation(() => deadline(100));
            const registry = registryFor(kms.url, {
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: "true",
            });
            const own = (registry.resolve("own", "tenant") as any).http;

            await expect(
                firstValueFrom(own.get(`${kms.url}/health`)),
            ).rejects.toMatchObject({ code: "ERR_CANCELED" });
            expect(timeout).toHaveBeenCalledWith(30_000);
            timeout.mockRestore();
        });

        it("do not follow a redirect from a tenant file's provider", async () => {
            const target = await listen();
            const kms = await listen((res) => {
                res.writeHead(302, { Location: `${target.url}/health` });
                res.end();
            });
            const registry = registryFor(kms.url, {
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: "true",
            });

            const health = await registry.health("tenant");

            expect(health).toContainEqual(
                expect.objectContaining({ providerId: "own", ok: false }),
            );
            expect(health).toContainEqual(
                expect.objectContaining({ providerId: "global", ok: true }),
            );
            // Both asked the server; only the global provider went on.
            expect(kms.hits).toBe(2);
            expect(target.hits).toBe(1);
        });
    });

    it("keeps a tenant's adapters while its configuration is the same", () => {
        const { registry } = setup();

        expect(registry.resolve("db", "tenant")).toBe(
            registry.resolve("db", "tenant"),
        );
    });

    it("builds the adapters again from a configuration that changed", () => {
        const { registry, replaceConfig } = setup();
        const before = registry.resolve("db", "tenant");

        replaceConfig({
            defaultProvider: "second",
            providers: [
                { id: "db", type: "db" },
                { id: "second", type: "db" },
            ],
        });

        expect(registry.resolve("db", "tenant")).not.toBe(before);
        expect(registry.getDefault("tenant").providerId).toBe("second");
        expect(registry.list("tenant").providers.map((p) => p.name)).toEqual([
            "db",
            "second",
        ]);
    });

    it("resolves an adapter with the tenant file of the same configuration", () => {
        const { registry } = setup();

        const { adapter, tenantFile } = registry.resolveWithTenantFile(
            "db",
            "tenant",
        );

        expect(adapter).toBe(registry.resolve("db", "tenant"));
        expect(tenantFile).toEqual({ providers: [] });
    });

    it("builds them again after the tenant was invalidated", () => {
        const { registry } = setup();
        const before = registry.resolve("db", "tenant");

        registry.invalidateTenant("tenant");

        expect(registry.resolve("db", "tenant")).not.toBe(before);
    });

    describe("adapters that are no longer handed out", () => {
        const withDispose = (
            registry: KmsProviderRegistry,
            tenantId?: string,
        ) => {
            const adapter = registry.resolve("db", tenantId);
            const dispose = vi.fn();
            (adapter as { dispose?: () => void }).dispose = dispose;
            return dispose;
        };

        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it("are disposed after the grace period when the configuration changed", () => {
            const { registry, replaceConfig } = setup();
            const dispose = withDispose(registry, "tenant");

            replaceConfig({ providers: [{ id: "db", type: "db" }] });
            registry.resolve("db", "tenant");

            // An operation that resolved the adapter earlier still finishes.
            vi.advanceTimersByTime(RETIRED_ADAPTER_GRACE_MS - 1);
            expect(dispose).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(dispose).toHaveBeenCalledTimes(1);
        });

        it("are disposed after the grace period when the tenant was invalidated", () => {
            const { registry } = setup();
            const dispose = withDispose(registry, "tenant");

            registry.invalidateTenant("tenant");
            registry.invalidateTenant("tenant");

            vi.advanceTimersByTime(RETIRED_ADAPTER_GRACE_MS);
            expect(dispose).toHaveBeenCalledTimes(1);
        });

        it("stay while the configuration is the same", () => {
            const { registry } = setup();
            const dispose = withDispose(registry, "tenant");

            registry.resolve("db", "tenant");

            vi.advanceTimersByTime(RETIRED_ADAPTER_GRACE_MS * 2);
            expect(dispose).not.toHaveBeenCalled();
        });

        const twoProviders: KmsConfig = {
            providers: [
                { id: "db", type: "db" },
                { id: "second", type: "db" },
            ],
        };
        /** Give both providers of the tenant a dispose; the first one fails. */
        const failingThenFine = (registry: KmsProviderRegistry) => {
            const failing = vi.fn().mockRejectedValue(new Error("token gone"));
            const fine = vi.fn();
            Object.assign(registry.resolve("db", "tenant"), {
                dispose: failing,
            });
            Object.assign(registry.resolve("second", "tenant"), {
                dispose: fine,
            });
            return { failing, fine };
        };

        it("are each disposed although one of the same configuration fails, which is logged", async () => {
            const warn = vi
                .spyOn(Logger.prototype, "warn")
                .mockImplementation(() => undefined);
            const { registry, replaceConfig } = setup();
            replaceConfig(twoProviders);
            const { failing, fine } = failingThenFine(registry);

            registry.invalidateTenant("tenant");
            await vi.advanceTimersByTimeAsync(RETIRED_ADAPTER_GRACE_MS);

            expect(failing).toHaveBeenCalledTimes(1);
            expect(fine).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(
                "Failed to dispose KMS provider 'db': token gone",
            );
            warn.mockRestore();
        });

        it("do not keep shutdown from disposing the rest when one fails", async () => {
            const warn = vi
                .spyOn(Logger.prototype, "warn")
                .mockImplementation(() => undefined);
            const { registry, replaceConfig } = setup();
            registry.onModuleInit();
            const global = withDispose(registry);
            replaceConfig(twoProviders);
            const { failing, fine } = failingThenFine(registry);

            await registry.onModuleDestroy();

            for (const dispose of [failing, fine, global]) {
                expect(dispose).toHaveBeenCalledTimes(1);
            }
            warn.mockRestore();
        });

        it("are disposed by their own dispose, as an aws-kms adapter has one", async () => {
            const dispose = vi
                .spyOn(AwsKmsAdapter.prototype, "dispose")
                .mockResolvedValue(undefined);
            const { registry, replaceConfig } = setup();
            replaceConfig({
                providers: [
                    { id: "aws", type: "aws-kms", region: "eu-central-1" },
                ],
            });
            const retired = registry.resolve("aws", "tenant");

            registry.invalidateTenant("tenant");
            await vi.advanceTimersByTimeAsync(RETIRED_ADAPTER_GRACE_MS);

            expect(dispose).toHaveBeenCalledTimes(1);
            expect(dispose.mock.contexts[0]).toBe(retired);
            dispose.mockRestore();
        });

        it("need no timer when they hold nothing open", () => {
            const { registry } = setup();
            registry.resolve("db", "tenant");

            registry.invalidateTenant("tenant");

            expect(vi.getTimerCount()).toBe(0);
        });

        it("are all disposed at shutdown, retired ones without waiting", async () => {
            const { registry, replaceConfig } = setup();
            registry.onModuleInit();
            const global = withDispose(registry);
            const retired = withDispose(registry, "tenant");
            replaceConfig({ providers: [{ id: "db", type: "db" }] });
            const current = withDispose(registry, "tenant");

            await registry.onModuleDestroy();

            for (const dispose of [global, retired, current]) {
                expect(dispose).toHaveBeenCalledTimes(1);
            }
            vi.advanceTimersByTime(RETIRED_ADAPTER_GRACE_MS);
            expect(retired).toHaveBeenCalledTimes(1);
        });
    });
});
