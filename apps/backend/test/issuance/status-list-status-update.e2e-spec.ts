import { INestApplication } from "@nestjs/common";
import { getListFromStatusListJWT } from "@owf/token-status-list";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { setupIssuanceTestApp } from "../utils.js";

const NARROW_CONFIG = "status-update-e2e-narrow";
const WIDE_CONFIG = "status-update-e2e-wide";
const SESSION_ID = "status-update-e2e";

describe("Status List - status updates", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let narrowListId: string;
    let wideListId: string;
    let narrowIndex: number;
    let wideIndex: number;
    let neighbourIndex: number;

    /** The status a verifier reads from the published status list token. */
    async function publishedStatus(
        listId: string,
        index: number,
    ): Promise<number> {
        const response = await request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${listId}`)
            .expect(200);
        return getListFromStatusListJWT(response.text).getStatus(index);
    }

    async function createList(
        credentialConfigurationId: string,
        bits: number,
    ): Promise<string> {
        const response = await request(app.getHttpServer())
            .post("/status-lists")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ credentialConfigurationId, bits, capacity: 1000 })
            .expect(201);
        return response.body.id;
    }

    async function allocate(
        sessionId: string,
        credentialConfigurationId: string,
        listId: string,
    ): Promise<number> {
        const payload = await app
            .get(StatusListService)
            .createEntry(
                { tenantId: "root", id: sessionId } as never,
                credentialConfigurationId,
            );
        expect(payload.status.status_list.uri).toMatch(
            new RegExp(`/${listId}$`),
        );
        return payload.status.status_list.idx;
    }

    function updateStatus(body: Record<string, unknown>) {
        return request(app.getHttpServer())
            .post("/session/revoke")
            .set("Authorization", `Bearer ${authToken}`)
            .send(body);
    }

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        // Publish new tokens on every update, so the tests read what a
        // verifier would read right after the change.
        await request(app.getHttpServer())
            .put("/status-list-config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ immediateUpdate: true })
            .expect(200);

        narrowListId = await createList(NARROW_CONFIG, 1);
        wideListId = await createList(WIDE_CONFIG, 2);

        narrowIndex = await allocate(SESSION_ID, NARROW_CONFIG, narrowListId);
        wideIndex = await allocate(SESSION_ID, WIDE_CONFIG, wideListId);
        neighbourIndex = await allocate(
            `${SESSION_ID}-neighbour`,
            NARROW_CONFIG,
            narrowListId,
        );
    });

    afterAll(async () => {
        await app?.close();
    });

    test("rejects suspension when one of the session's lists has 1 bit per entry, changing no entry", async () => {
        const response = await updateStatus({
            sessionId: SESSION_ID,
            status: 2,
        }).expect(400);

        expect(response.body.message).toBe(
            `Status 2 (suspended) requires a status list with at least 2 bits per entry; list ${narrowListId} uses 1 bit.`,
        );
        expect(await publishedStatus(wideListId, wideIndex)).toBe(0);
        expect(await publishedStatus(narrowListId, narrowIndex)).toBe(0);
        expect(await publishedStatus(narrowListId, neighbourIndex)).toBe(0);
    });

    test("suspends a credential on a list with 2 bits per entry", async () => {
        await updateStatus({
            sessionId: SESSION_ID,
            credentialConfigurationId: WIDE_CONFIG,
            status: 2,
        }).expect(204);

        expect(await publishedStatus(wideListId, wideIndex)).toBe(2);
        expect(await publishedStatus(narrowListId, narrowIndex)).toBe(0);
    });

    test("revokes every credential of the session without touching other entries", async () => {
        await updateStatus({ sessionId: SESSION_ID, status: 1 }).expect(204);

        expect(await publishedStatus(narrowListId, narrowIndex)).toBe(1);
        expect(await publishedStatus(wideListId, wideIndex)).toBe(1);
        expect(await publishedStatus(narrowListId, neighbourIndex)).toBe(0);
    });
});
