import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
    lookup: vi.fn(),
}));
vi.mock("node:dns", () => ({
    lookup: vi.fn(),
}));

import { lookup as lookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";

type ConfigValue = string | boolean | undefined;

describe("OutboundUrlPolicyService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function createService(config: Record<string, ConfigValue> = {}) {
        const configService = {
            get: vi.fn((key: string) => config[key]),
        };

        return {
            service: new OutboundUrlPolicyService(configService as any),
            configService,
        };
    }

    it("rejects invalid URL values", async () => {
        const { service } = createService();

        await expect(service.assertSafeUrl("not-a-url")).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it("rejects HTTP by default, independent of NODE_ENV", async () => {
        vi.stubEnv("NODE_ENV", "development");
        const { service } = createService();

        await expect(
            service.assertSafeUrl("http://example.com/webhook"),
        ).rejects.toBeInstanceOf(BadRequestException);
        vi.unstubAllEnvs();
    });

    it("allows HTTP when explicitly enabled", async () => {
        vi.mocked(lookup).mockResolvedValue([
            { address: "93.184.216.34", family: 4 },
        ]);
        const { service } = createService({ OUTBOUND_URL_ALLOW_HTTP: true });

        await expect(
            service.assertSafeUrl("http://example.com/webhook"),
        ).resolves.toBeUndefined();
    });

    it("uses secure ConfigService fallback values for policy flags", () => {
        const configService = {
            get: vi.fn(
                (key: string, defaultValue?: boolean | string) => defaultValue,
            ),
        };
        const service = new OutboundUrlPolicyService(configService as any);

        expect(service["allowHttp"]()).toBe(false);
        expect(configService.get).toHaveBeenCalledWith(
            "OUTBOUND_URL_ALLOW_HTTP",
            false,
        );

        expect(service["allowPrivateNetwork"]()).toBe(false);
        expect(configService.get).toHaveBeenCalledWith(
            "OUTBOUND_URL_ALLOW_PRIVATE_NETWORK",
            false,
        );
    });

    it("rejects localhost targets", async () => {
        const { service } = createService();

        await expect(
            service.assertSafeUrl("https://localhost/internal"),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects direct private IP targets", async () => {
        const { service } = createService();

        await expect(
            service.assertSafeUrl("https://10.0.0.1/internal"),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects IPv6 literals that route to private addresses", async () => {
        const { service } = createService();

        for (const url of [
            "https://[::1]/internal",
            "https://[64:ff9b::a9fe:a9fe]/latest/meta-data",
            "https://[2002:a00:5::1]/internal",
        ]) {
            await expect(service.assertSafeUrl(url)).rejects.toThrow(
                "private or loopback",
            );
        }
        expect(lookup).not.toHaveBeenCalled();
    });

    it("allows public IPv6 literals without a DNS lookup", async () => {
        const { service } = createService();

        await expect(
            service.assertSafeUrl("https://[2606:4700:4700::1111]/webhook"),
        ).resolves.toBeUndefined();
        expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects hostnames with an AAAA record into NAT64 private space", async () => {
        vi.mocked(lookup).mockResolvedValue([
            { address: "93.184.216.34", family: 4 },
            { address: "64:ff9b::a00:5", family: 6 },
        ]);

        const { service } = createService();

        await expect(
            service.assertSafeUrl("https://issuer.example/webhook"),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a connection to NAT64 private space at connect time", async () => {
        vi.mocked(lookupCallback).mockImplementation(((
            _hostname: string,
            _options: unknown,
            callback: (error: null, addresses: unknown[]) => void,
        ) =>
            callback(null, [
                { address: "93.184.216.34", family: 4 },
                { address: "64:ff9b::a9fe:a9fe", family: 6 },
            ])) as never);
        const connect = (service: OutboundUrlPolicyService) =>
            new Promise<Error | null>((resolve) =>
                service.safeLookup("issuer.example", { all: true }, (error) =>
                    resolve(error),
                ),
            );

        const blocked = await connect(createService().service);
        expect(blocked?.message).toContain("private or loopback IP");

        const allowed = await connect(
            createService({ OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true }).service,
        );
        expect(allowed).toBeNull();
    });

    it("rejects hostnames that resolve to private IPs", async () => {
        vi.mocked(lookup).mockResolvedValue([
            { address: "127.0.0.1", family: 4 },
        ]);

        const { service } = createService();

        await expect(
            service.assertSafeUrl("https://issuer.example/webhook"),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("allows configured host allowlist including subdomains", async () => {
        vi.mocked(lookup).mockResolvedValue([
            { address: "93.184.216.34", family: 4 },
        ]);

        const { service } = createService({
            OUTBOUND_URL_ALLOWED_HOSTS: "example.com",
        });

        await expect(
            service.assertSafeUrl("https://hooks.example.com/webhook"),
        ).resolves.toBeUndefined();
    });

    it("rejects hosts outside configured allowlist", async () => {
        const { service } = createService({
            OUTBOUND_URL_ALLOWED_HOSTS: "example.com",
        });

        await expect(
            service.assertSafeUrl("https://attacker.test/webhook"),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("allows private network targets when explicitly enabled", async () => {
        const { service } = createService({
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
        });

        await expect(
            service.assertSafeUrl("https://10.1.2.3/internal"),
        ).resolves.toBeUndefined();
    });
});
