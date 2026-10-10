import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { HttpService } from "@nestjs/axios";
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
import type { SessionData } from "../session/domain/session-data.js";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";
import { WebhookService } from "./webhook.service.js";

interface ReceivedRequest {
    server: "main" | "other";
    path: string;
    method: string;
    apiKey?: string | string[];
    body: string;
}

/** Real sockets against local receivers; complements the mocked spec. */
describe("WebhookService deliveries", () => {
    let main: Server;
    let other: Server;
    let mainUrl: string;
    let otherUrl: string;
    let received: ReceivedRequest[];
    let logger: { setContext: any; debug: any; error: any };
    let service: WebhookService;

    const session = {
        id: "session-1",
        tenantId: "tenant-1",
    } as unknown as SessionData;

    function receiver(name: ReceivedRequest["server"]) {
        return (request: IncomingMessage, response: ServerResponse) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const path = request.url ?? "";
                received.push({
                    server: name,
                    path,
                    method: request.method ?? "",
                    apiKey: request.headers["x-api-key"],
                    body: Buffer.concat(chunks).toString(),
                });
                const redirect = (status: number, location: string) => {
                    response.writeHead(status, { location });
                    response.end();
                };
                if (path === "/redirect-307") return redirect(307, "/claims");
                if (path === "/redirect-302-then-307") {
                    return redirect(302, "/redirect-307");
                }
                if (path === "/redirect-no-location") {
                    response.writeHead(302);
                    response.end();
                    return;
                }
                if (path === "/redirect-via-other") {
                    return redirect(307, `${otherUrl}/back`);
                }
                if (path === "/back") return redirect(307, `${mainUrl}/claims`);
                if (path === "/slow") {
                    response.writeHead(200, {
                        "content-type": "application/json",
                    });
                    response.write("{");
                    return;
                }
                if (path === "/redirect-302") return redirect(302, "/claims");
                if (path === "/redirect-other-origin") {
                    return redirect(307, `${otherUrl}/claims`);
                }
                // localhost is not on the allowlist of the policy below.
                if (path === "/redirect-blocked") {
                    const { port } = main.address() as AddressInfo;
                    return redirect(307, `http://localhost:${port}/claims`);
                }
                if (path === "/loop") return redirect(307, "/loop");
                if (path === "/error") {
                    response.writeHead(500);
                    response.end();
                    return;
                }
                response.setHeader("content-type", "application/json");
                if (path === "/large") {
                    response.end(
                        JSON.stringify({
                            pid: { blob: "x".repeat(6 * 1024 * 1024) },
                        }),
                    );
                    return;
                }
                response.end(JSON.stringify({ pid: { given_name: "Erika" } }));
            });
        };
    }

    async function listen(server: Server) {
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    beforeAll(async () => {
        main = createServer(receiver("main"));
        other = createServer(receiver("other"));
        mainUrl = await listen(main);
        otherUrl = await listen(other);
    });

    afterAll(async () => {
        for (const server of [main, other]) server.closeAllConnections();
        await Promise.all(
            [main, other].map(
                (server) =>
                    new Promise<void>((resolve) =>
                        server.close(() => resolve()),
                    ),
            ),
        );
    });

    beforeEach(() => {
        received = [];
        logger = { setContext: vi.fn(), debug: vi.fn(), error: vi.fn() };
        const config: Record<string, unknown> = {
            OUTBOUND_URL_ALLOW_HTTP: true,
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
            OUTBOUND_URL_ALLOWED_HOSTS: "127.0.0.1",
        };
        service = new WebhookService(
            new HttpService(axios.create()),
            new OutboundUrlPolicyService({
                get: (key: string) => config[key],
            } as never),
            logger as never,
        );
    });

    function webhook(path: string) {
        return {
            url: `${mainUrl}${path}`,
            auth: {
                type: "apiKey" as const,
                config: { headerName: "x-api-key", value: "secret" },
            },
        };
    }

    function claims(path: string) {
        return service.sendClaimsWebhook({
            webhook: webhook(path),
            session: "session-1",
            credentialConfigurationId: "pid",
        });
    }

    async function failure(promise: Promise<unknown>): Promise<Error> {
        return promise.then(
            () => {
                throw new Error("expected the delivery to fail");
            },
            (err: Error) => err,
        );
    }

    it("returns the claims of a receiver that answers directly", async () => {
        await expect(claims("/claims")).resolves.toEqual({
            pid: { given_name: "Erika" },
        });
        expect(received).toMatchObject([
            { path: "/claims", method: "POST", apiKey: "secret" },
        ]);
    });

    it("repeats the POST with body and API key after a 307 on the same origin", async () => {
        await expect(claims("/redirect-307")).resolves.toEqual({
            pid: { given_name: "Erika" },
        });

        expect(received).toHaveLength(2);
        expect(received[1]).toMatchObject({
            server: "main",
            path: "/claims",
            method: "POST",
            apiKey: "secret",
        });
        expect(JSON.parse(received[1].body)).toMatchObject({
            session: "session-1",
            credential_configuration_id: "pid",
        });
    });

    it("continues with a GET without body after a 302", async () => {
        await claims("/redirect-302");

        expect(received[1]).toMatchObject({
            path: "/claims",
            method: "GET",
            body: "",
        });
    });

    it("does not send the API key to another origin", async () => {
        await claims("/redirect-other-origin");

        expect(received[1]).toMatchObject({
            server: "other",
            path: "/claims",
            method: "POST",
        });
        expect(received[1].apiKey).toBeUndefined();
    });

    it.each([
        ["claims webhook", () => claims("/redirect-blocked")],
        [
            "presentation webhook",
            () =>
                service.sendWebhook({
                    webhook: webhook("/redirect-blocked"),
                    session,
                }),
        ],
        [
            "cancellation webhook",
            () =>
                service.sendSessionCancelledWebhook(
                    webhook("/redirect-blocked"),
                    session,
                ),
        ],
    ])(
        "does not follow a redirect of the %s to a blocked URL",
        async (_, send) => {
            const error = await failure(send());

            expect(received.map(({ path }) => path)).toEqual([
                "/redirect-blocked",
            ]);
            expect(error.message).toContain(
                "redirected to a URL that the outbound URL policy blocks",
            );
            // The message can reach the wallet; only the log names the target.
            expect(error.message).not.toContain("localhost");
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    redirectTarget: expect.stringMatching(
                        /^http:\/\/localhost:\d+\/claims$/,
                    ),
                }),
                expect.any(String),
            );
        },
    );

    it("stops after 5 redirects", async () => {
        const error = await failure(claims("/loop"));

        expect(error.message).toContain("redirected more than 5 times");
        expect(received).toHaveLength(6);
    });

    it("keeps a 302 downgrade to GET for later 307 hops", async () => {
        await claims("/redirect-302-then-307");

        expect(received.map(({ method }) => method)).toEqual([
            "POST",
            "GET",
            "GET",
        ]);
    });

    it("sends the API key again when a redirect returns to the webhook's origin", async () => {
        await claims("/redirect-via-other");

        expect(received.map(({ server, apiKey }) => [server, apiKey])).toEqual([
            ["main", "secret"],
            ["other", undefined],
            ["main", "secret"],
        ]);
    });

    it("fails on a redirect without a location", async () => {
        const error = await failure(claims("/redirect-no-location"));

        expect(error.message).toContain(
            "redirect (HTTP 302) without a location",
        );
        expect(received).toHaveLength(1);
    });

    it("ends a delivery whose answer does not finish in time", async () => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        const spy = vi
            .spyOn(AbortSignal, "timeout")
            .mockImplementation(() => timeout(200));
        try {
            await expect(claims("/slow")).rejects.toThrow(
                "Error sending claims webhook: the webhook did not answer within 60 seconds",
            );
        } finally {
            spy.mockRestore();
        }
    });

    it("describes a failed status without the receiver's details", async () => {
        await expect(claims("/error")).rejects.toThrow(
            "Error sending claims webhook: the webhook answered with HTTP 500",
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Request failed with status code 500",
            }),
            "Error sending claims webhook",
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.not.objectContaining({ redirectTarget: expect.anything() }),
            "Error sending claims webhook",
        );
    });

    // The message reaches the wallet; Node's message names the address.
    it("does not name the address of an unreachable receiver", async () => {
        const closed = createServer();
        const url = await listen(closed);
        await new Promise<void>((resolve) => closed.close(() => resolve()));

        const error = await failure(
            service.sendClaimsWebhook({
                webhook: { url: `${url}/claims`, auth: { type: "none" } },
                session: "session-1",
                credentialConfigurationId: "pid",
            }),
        );

        expect(error.message).toBe(
            "Error sending claims webhook: the webhook could not be reached",
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.stringContaining("ECONNREFUSED"),
            }),
            "Error sending claims webhook",
        );
    });

    it("rejects a response larger than 5 MiB", async () => {
        await expect(claims("/large")).rejects.toThrow(
            "Error sending claims webhook: the webhook answer exceeds 5 MiB",
        );
    });
});
