import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpService } from "@nestjs/axios";
import {
    BadRequestException,
    ServiceUnavailableException,
} from "@nestjs/common";
import axios from "axios";
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
import {
    relyingPartyControllerFindAll,
    relyingPartyControllerRegister,
} from "./generated/index.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";

vi.mock("./generated/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./generated/index.js")>()),
    relyingPartyControllerFindAll: vi.fn(),
    relyingPartyControllerRegister: vi.fn(),
}));

describe("RegistrarAuthService.getRelyingPartyId", () => {
    let service: RegistrarAuthService;

    beforeEach(() => {
        vi.mocked(relyingPartyControllerFindAll).mockReset();
        vi.mocked(relyingPartyControllerRegister).mockReset();
        service = new RegistrarAuthService({} as any, {} as any, {} as any);
        vi.spyOn(service, "getClient").mockResolvedValue({} as any);
    });

    it("returns the first existing relying party without registering one", async () => {
        vi.mocked(relyingPartyControllerFindAll).mockResolvedValue({
            data: [{ id: "rp-1" }, { id: "rp-2" }],
        } as any);

        await expect(service.getRelyingPartyId("tenant")).resolves.toBe("rp-1");
        expect(relyingPartyControllerRegister).not.toHaveBeenCalled();
    });

    it("registers a relying party when none exists", async () => {
        vi.mocked(relyingPartyControllerFindAll).mockResolvedValue({
            data: [],
        } as any);
        vi.mocked(relyingPartyControllerRegister).mockResolvedValue({
            data: { id: "rp-new" },
        } as any);

        await expect(service.getRelyingPartyId("tenant")).resolves.toBe(
            "rp-new",
        );
    });

    it("throws a BadRequestException when the registrar rejects the registration", async () => {
        vi.mocked(relyingPartyControllerFindAll).mockResolvedValue({
            data: [],
        } as any);
        vi.mocked(relyingPartyControllerRegister).mockResolvedValue({
            data: undefined,
            error: { statusCode: 403, message: "Forbidden" },
        } as any);

        await expect(service.getRelyingPartyId("tenant")).rejects.toThrow(
            new BadRequestException(
                "Failed to register relying party at registrar",
            ),
        );
    });
});

/**
 * Real requests against a local server standing in for the registrar and its
 * OIDC provider: both URLs are tenant-controlled and go through the outbound
 * URL policy.
 */
describe("RegistrarAuthService outbound requests", () => {
    let server: Server;
    let localhost: string;
    let loopbackIp: string;
    let requests: { method?: string; url?: string }[];

    beforeAll(async () => {
        server = createServer((request, response) => {
            requests.push({ method: request.method, url: request.url });
            request.resume();
            request.on("end", () => {
                response.setHeader("content-type", "application/json");
                if (request.url === "/oidc/.well-known/openid-configuration") {
                    // Points the token endpoint at another host.
                    response.end(
                        JSON.stringify({
                            token_endpoint: `${loopbackIp}/token`,
                        }),
                    );
                    return;
                }
                if (request.url?.endsWith("/token")) {
                    response.writeHead(401);
                    response.end(
                        JSON.stringify({
                            error: "invalid_grant",
                            error_description: "upstream detail",
                        }),
                    );
                    return;
                }
                if (request.url === "/registrar/redirect") {
                    response.writeHead(302, {
                        location: "http://169.254.169.254/",
                    });
                    response.end();
                    return;
                }
                response.writeHead(404);
                response.end("{}");
            });
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

    const policy = (config: Record<string, unknown> = {}) =>
        new OutboundUrlPolicyService({
            get: vi.fn(
                (key: string, fallback?: unknown) => config[key] ?? fallback,
            ),
        } as never);
    /** Allows the local server only by the name `localhost`. */
    const localhostOnly = () =>
        policy({
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
            OUTBOUND_URL_ALLOWED_HOSTS: "localhost",
        });
    const service = (
        outboundUrlPolicy: OutboundUrlPolicyService,
        configs: Record<string, object> = {},
    ) =>
        new RegistrarAuthService(
            {
                findOneBy: vi.fn(
                    async ({ tenantId }: { tenantId: string }) =>
                        configs[tenantId] ?? null,
                ),
            } as any,
            outboundUrlPolicy,
            new HttpService(axios.create()),
        );
    const credentials = {
        clientId: "client",
        username: "user",
        password: "password",
    };

    describe("testCredentials", () => {
        it("rejects a blocked OIDC URL without sending a request", async () => {
            await expect(
                service(
                    policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
                ).testCredentials({
                    ...credentials,
                    oidcUrl: `${loopbackIp}/oidc`,
                }),
            ).rejects.toThrow("private or loopback IP");
            expect(requests).toEqual([]);
        });

        it("checks the token endpoint named by the discovery document", async () => {
            const result = service(localhostOnly()).testCredentials({
                ...credentials,
                oidcUrl: `${localhost}/oidc`,
            });

            // Fixed message: the cause is only logged, so the response does
            // not tell whether the address is reachable.
            await expect(result).rejects.toThrow(
                new ServiceUnavailableException(
                    "Registrar OIDC endpoint is not reachable. Credentials could not be verified.",
                ),
            );
            expect(requests.map(({ url }) => url)).toEqual([
                "/oidc/.well-known/openid-configuration",
            ]);
        });
    });

    describe("getAccessToken", () => {
        it("does not pass on the OIDC provider's error description", async () => {
            const result = service(
                policy({
                    OUTBOUND_URL_ALLOW_HTTP: true,
                    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
                }),
                {
                    // No discovery document under this path, so the
                    // client falls back to its default token endpoint.
                    tenant: { ...credentials, oidcUrl: `${localhost}/plain` },
                },
            ).getAccessToken("tenant");

            await expect(result).rejects.toThrow(
                new BadRequestException(
                    "Failed to authenticate with registrar (HTTP 401)",
                ),
            );
        });
    });

    describe("getClient", () => {
        it("rejects a blocked registrar URL before requesting a token", async () => {
            const authService = service(
                policy({ OUTBOUND_URL_ALLOW_HTTP: true }),
                {
                    tenant: {
                        ...credentials,
                        registrarUrl: `${loopbackIp}/registrar`,
                        oidcUrl: `${localhost}/oidc`,
                    },
                },
            );
            const getAccessToken = vi.spyOn(authService, "getAccessToken");

            await expect(authService.getClient("tenant")).rejects.toThrow(
                "private or loopback IP",
            );
            expect(getAccessToken).not.toHaveBeenCalled();
            expect(requests).toEqual([]);
        });

        it("creates a separate client per call", async () => {
            const authService = service(localhostOnly(), {
                a: { registrarUrl: `${localhost}/registrar-a` },
                b: { registrarUrl: `${localhost}/registrar-b` },
            });
            vi.spyOn(authService, "getAccessToken").mockImplementation(
                async (tenantId) => `token-${tenantId}`,
            );

            const [a, b] = await Promise.all([
                authService.getClient("a"),
                authService.getClient("b"),
            ]);

            expect(a).not.toBe(b);
            expect(a.getConfig().baseUrl).toBe(`${localhost}/registrar-a`);
            expect(b.getConfig().baseUrl).toBe(`${localhost}/registrar-b`);
            expect((a.getConfig().auth as () => string)()).toBe("token-a");
            expect((b.getConfig().auth as () => string)()).toBe("token-b");
        });

        it("sends registrar requests through the outbound URL policy", async () => {
            const authService = service(localhostOnly(), {
                tenant: { registrarUrl: `${localhost}/registrar` },
            });
            vi.spyOn(authService, "getAccessToken").mockResolvedValue("token");
            const client = await authService.getClient("tenant");

            const result = await client.get({ url: "/redirect" });

            expect((result.error as Error).message).toBe(
                `Request to ${localhost}/registrar/redirect was redirected to http://169.254.169.254/; redirects are not followed`,
            );
            expect(requests.map(({ url }) => url)).toEqual([
                "/registrar/redirect",
            ]);
        });
    });

    describe("assertSafeUrls", () => {
        it("checks only the URLs that are given", async () => {
            const outboundUrlPolicy = policy();
            const assertSafeUrl = vi
                .spyOn(outboundUrlPolicy, "assertSafeUrl")
                .mockResolvedValue();

            await service(outboundUrlPolicy).assertSafeUrls({
                registrarUrl: "https://registrar.example",
            });

            expect(assertSafeUrl).toHaveBeenCalledTimes(1);
            expect(assertSafeUrl).toHaveBeenCalledWith(
                "https://registrar.example",
            );
        });
    });
});
