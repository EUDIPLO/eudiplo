import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { getToken, setupIssuanceTestApp } from "../utils.js";

describe("Session list filters and search", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let issuance: { session: string; uri: string };
    let presentation: { session: string; uri: string; crossDeviceUri: string };

    const list = (query: string, token = authToken) =>
        request(app.getHttpServer())
            .get(`/session?${query}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${token}`);
    const ids = async (query: string) =>
        (await list(query).expect(200)).body.items.map(
            (item: { id: string }) => item.id,
        );

    beforeAll(async () => {
        ({ app, authToken } = await setupIssuanceTestApp());
        issuance = (
            await request(app.getHttpServer())
                .post("/issuer/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                    reference: "order-4711",
                })
                .expect(201)
        ).body;
        presentation = (
            await request(app.getHttpServer())
                .post("/verifier/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid",
                    reference: "case-42",
                })
                .expect(201)
        ).body;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("returns the reference and the new summary fields", async () => {
        const { body } = await list(`q=order-4711`).expect(200);
        expect(body.items).toEqual([
            expect.objectContaining({
                id: issuance.session,
                status: "active",
                reference: "order-4711",
                requestId: null,
                failureCode: null,
                updatedAt: expect.any(String),
            }),
        ]);
        const detail = await request(app.getHttpServer())
            .get(`/session/${issuance.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(detail.body).toMatchObject({
            reference: "order-4711",
            credentialConfigurationIds: ["pid-no-key"],
        });
    });

    test("finds the session behind a pasted offer or request link", async () => {
        expect(await ids(`q=${encodeURIComponent(issuance.uri)}`)).toEqual([
            issuance.session,
        ]);
        for (const link of [presentation.uri, presentation.crossDeviceUri])
            expect(await ids(`q=${encodeURIComponent(link)}`)).toEqual([
                presentation.session,
            ]);
        expect(await ids(`q=${issuance.session.slice(0, 8)}`)).toContain(
            issuance.session,
        );
    });

    test("filters by configuration, type, status and time", async () => {
        expect(await ids("credentialConfigurationId=pid-no-key")).toEqual([
            issuance.session,
        ]);
        expect(await ids("requestId=pid")).toEqual([presentation.session]);
        expect(
            await ids("type=presentation&status=active&status=fetched"),
        ).toEqual([presentation.session]);
        expect(
            await ids(
                `createdFrom=${new Date(Date.now() + 60_000).toISOString()}`,
            ),
        ).toEqual([]);
        const all = await ids(
            "sortBy=updatedAt&sortOrder=asc&updatedFrom=2020-01-01T00:00:00Z",
        );
        expect(all).toEqual([issuance.session, presentation.session]);
    });

    test.each([
        "createdFrom=2026-10-02T10:00:00Z&createdTo=2026-10-02T08:00:00Z",
        "updatedFrom=yesterday",
        "status=pending",
        "id=order-4711",
        "sortBy=reference",
        `requestId=${"a".repeat(256)}`,
        "tenantId=other",
    ])("rejects an invalid query: %s", async (query) => {
        expect((await list(query)).status).toBe(400);
    });

    test("never returns sessions of another tenant", async () => {
        const config = app.get(ConfigService);
        const otherToken = await getToken(
            app,
            config.getOrThrow("AUTH_CLIENT_ID"),
            config.getOrThrow("AUTH_CLIENT_SECRET"),
            "other",
        );
        for (const query of [
            "",
            "q=order-4711",
            `q=${encodeURIComponent(issuance.uri)}`,
            `q=${encodeURIComponent(presentation.crossDeviceUri)}`,
            "credentialConfigurationId=pid-no-key",
            "requestId=pid",
        ]) {
            const { body } = await list(query, otherToken).expect(200);
            expect(body).toMatchObject({ total: 0, items: [] });
        }
    });

    test("rejects an over-long reference on both offer types", async () => {
        const reference = "x".repeat(256);
        const issuanceOffer = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
                reference,
            });
        const presentationOffer = await request(app.getHttpServer())
            .post("/verifier/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: ResponseType.URI,
                requestId: "pid",
                reference,
            });
        expect(issuanceOffer.status).toBe(400);
        expect(presentationOffer.status).toBe(400);
    });
});
