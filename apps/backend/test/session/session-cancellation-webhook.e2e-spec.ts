import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { SessionCancellationWebhookListener } from "../../src/webhook/session-cancellation-webhook.listener.js";
import {
    createPresentationRequest,
    setupIssuanceTestApp,
    setupPresentationTestApp,
} from "../utils.js";

const receiver = "http://localhost:8787";

interface Delivery {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
}

/**
 * Registers a receiver for one POST. The listener sends the webhook after the
 * cancel request has answered, so tests wait for the delivery with
 * {@link delivered} instead of checking right away.
 */
function receive(path: string, status = 200): Delivery[] {
    const deliveries: Delivery[] = [];
    nock(receiver)
        .post(path)
        .reply(function (_uri, body) {
            deliveries.push({
                body: typeof body === "string" ? JSON.parse(body) : body,
                headers: this.req.headers,
            });
            return [status, ""];
        });
    return deliveries;
}

async function delivered(deliveries: Delivery[]): Promise<Delivery> {
    await vi.waitFor(() => expect(deliveries).toHaveLength(1), {
        timeout: 10_000,
    });
    return deliveries[0];
}

function cancel(
    app: INestApplication<App>,
    authToken: string,
    sessionId: string,
    body: Record<string, unknown> = {},
) {
    return request(app.getHttpServer())
        .post(`/session/${sessionId}/cancel`)
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(body)
        .expect(204);
}

async function sessionStatus(
    app: INestApplication<App>,
    authToken: string,
    sessionId: string,
) {
    const res = await request(app.getHttpServer())
        .get(`/session/${sessionId}`)
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);
    return res.body.status as string;
}

describe("Session cancellation webhook - OID4VCI", () => {
    let app: INestApplication<App>;
    let authToken: string;

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        await request(app.getHttpServer())
            .post("/issuer/webhook-endpoints")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "cancellation-events",
                name: "Cancellation events",
                url: `${receiver}/cancelled`,
                auth: {
                    type: "apiKey",
                    config: { headerName: "x-api-key", value: "cancel-key" },
                },
            })
            .expect(201);
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
    });

    async function createOffer() {
        const res = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
                webhookEndpointId: "cancellation-events",
                reference: "order-4711",
            })
            .expect(201);
        return res.body.session as string;
    }

    test("reports the cancelled offer to the webhook endpoint of the offer", async () => {
        const sessionId = await createOffer();
        const delivery = receive("/cancelled");

        await cancel(app, authToken, sessionId, {
            reason: "sent to wrong recipient",
        });

        const { body, headers } = await delivered(delivery);
        expect(body).toEqual({
            status: "cancelled",
            session: sessionId,
            reference: "order-4711",
            reason: "sent to wrong recipient",
        });
        expect(headers["x-api-key"]).toBe("cancel-key");
    });

    test("keeps the session cancelled when the delivery fails", async () => {
        const listener = app.get(SessionCancellationWebhookListener);
        const warn = vi.spyOn(
            (listener as unknown as { logger: { warn: () => void } }).logger,
            "warn",
        );
        const sessionId = await createOffer();
        const delivery = receive("/cancelled", 500);

        await cancel(app, authToken, sessionId);

        expect(await delivered(delivery)).toMatchObject({
            body: { status: "cancelled", session: sessionId },
        });
        // Read the status only after the listener handled the failure.
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        warn.mockRestore();
        expect(await sessionStatus(app, authToken, sessionId)).toBe(
            "cancelled",
        );
    });
});

describe("Session cancellation webhook - OID4VP", () => {
    let app: INestApplication<App>;
    let authToken: string;

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
    });

    // The pid configuration also has a webhook endpoint, so this also shows
    // that the webhook passed with the request wins.
    test("reports a cancelled request to the webhook passed with it", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid",
            webhook: {
                url: `${receiver}/presentation-cancelled`,
                auth: { type: "none" },
            },
        });
        const sessionId: string = res.body.session;
        const delivery = receive("/presentation-cancelled");

        await cancel(app, authToken, sessionId);

        // Without a reason or reference, neither field is sent.
        expect((await delivered(delivery)).body).toEqual({
            status: "cancelled",
            session: sessionId,
        });
    });

    test("reports a cancelled request to the webhook endpoint of the presentation configuration", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid",
        });
        const sessionId: string = res.body.session;
        // Webhook endpoint "notification" of the pid configuration
        const delivery = receive("/consume");

        await cancel(app, authToken, sessionId, {
            reason: "checkout cancelled",
        });

        const { body, headers } = await delivered(delivery);
        expect(body).toEqual({
            status: "cancelled",
            session: sessionId,
            reason: "checkout cancelled",
        });
        expect(headers["x-api-key"]).toBe("foo-bar");
    });
});
