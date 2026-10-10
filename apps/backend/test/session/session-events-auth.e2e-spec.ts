import { join, resolve } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Role } from "../../src/auth/roles/role.enum.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../../src/verifier/presentations/dto/presentation-config-create.dto.js";
import {
    clientToken,
    type IssuanceTestContext,
    readConfig,
    setupIssuanceTestApp,
} from "../utils.js";

/**
 * The event stream is authorized like `GET /session/{id}`. These tests use
 * tokens from the token endpoint, so a mismatch between the issued token and
 * what the endpoint expects cannot go unnoticed again.
 */
describe("Session events authorization", () => {
    let ctx: IssuanceTestContext;
    let issuanceSession: string;
    let presentationSession: string;
    let verifierToken: string;
    let clientsOnlyToken: string;

    /** Opens the stream like a backend would and reads the first event. */
    async function subscribe(
        sessionId: string,
        { token, query = "" }: { token?: string; query?: string },
    ): Promise<{ status: number; contentType?: string; firstEvent?: string }> {
        const abort = new AbortController();
        try {
            const response = await fetch(
                `http://localhost:3000/session/${sessionId}/events${query}`,
                {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                    signal: abort.signal,
                },
            );
            const contentType = response.headers.get("content-type") ?? "";
            if (response.status !== 200) {
                return { status: response.status, contentType };
            }
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let firstEvent = "";
            while (!firstEvent.includes("\n\n")) {
                const { value, done } = await reader.read();
                if (done) break;
                firstEvent += decoder.decode(value, { stream: true });
            }
            return { status: response.status, contentType, firstEvent };
        } finally {
            abort.abort();
        }
    }

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        const server = ctx.app.getHttpServer();

        await request(server)
            .post("/verifier/config")
            .set("Authorization", `Bearer ${ctx.authToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(
                        resolve(__dirname, "../fixtures"),
                        "haip/presentation/pid-no-hook.json",
                    ),
                ),
            )
            .expect(201);

        issuanceSession = (
            await request(server)
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                })
                .expect(201)
        ).body.session;
        presentationSession = (
            await request(server)
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid-no-hook",
                })
                .expect(201)
        ).body.session;

        verifierToken = await clientToken(
            ctx.app,
            ctx.authToken,
            "events-verifier",
            [Role.PresentationRequest],
        );
        clientsOnlyToken = await clientToken(
            ctx.app,
            ctx.authToken,
            "events-client-admin",
            [Role.Clients],
        );
    });

    afterAll(async () => {
        await ctx?.app?.close();
    });

    test("streams the current status to an issued token in the Authorization header", async () => {
        const result = await subscribe(issuanceSession, {
            token: ctx.authToken,
        });

        expect(result.status).toBe(200);
        expect(result.contentType).toContain("text/event-stream");
        expect(result.firstEvent).toContain(`"id":"${issuanceSession}"`);
        expect(result.firstEvent).toContain('"status":"active"');
    });

    test("streams a presentation session to a verifier-only client", async () => {
        const result = await subscribe(presentationSession, {
            token: verifierToken,
        });

        expect(result.status).toBe(200);
        expect(result.firstEvent).toContain(`"id":"${presentationSession}"`);
    });

    test("treats an issuance session as missing for a verifier-only client", async () => {
        const outOfScope = await subscribe(issuanceSession, {
            token: verifierToken,
        });
        const unknown = await subscribe(
            "00000000-0000-0000-0000-000000000000",
            {
                token: verifierToken,
            },
        );

        // Production maps both to 404 (AllExceptionsFilter, not registered in
        // the E2E app); what matters here is that they are indistinguishable.
        expect(outOfScope.status).not.toBe(200);
        expect(outOfScope.status).toBe(unknown.status);
        expect(outOfScope.contentType).not.toContain("text/event-stream");
    });

    test("rejects a token in the query string", async () => {
        const result = await subscribe(issuanceSession, {
            query: `?token=${encodeURIComponent(ctx.authToken)}`,
        });

        expect(result.status).toBe(401);
    });

    test("rejects a client without a session role", async () => {
        const result = await subscribe(issuanceSession, {
            token: clientsOnlyToken,
        });

        expect(result.status).toBe(403);
    });
});
