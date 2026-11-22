import { INestApplication } from "@nestjs/common";
import { decodeStatusListJwt } from "@owf/token-status-list";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Role } from "../../src/auth/roles/role.enum.js";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { setupIssuanceTestApp } from "../utils.js";

const CONFIG = "disclosure-policy-revocation-e2e";
const OTHER_CONFIG = "disclosure-policy-revocation-e2e-other";
const POLICY_A = { policy: "allowList", values: ["https://rp-a.example"] };
const POLICY_B = { policy: "allowList", values: ["https://rp-b.example"] };

/**
 * ARF Annex 2, EDP_11: changing the embedded disclosure policy revokes the
 * credentials issued under the old one, when the update asks for it.
 */
describe("Credential configuration - revocation on disclosure policy change", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let listId: string;
    let otherListId: string;
    let indexes: number[];
    let otherIndex: number;

    async function publishedStatus(id: string, index: number) {
        const response = await request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${id}`)
            .expect(200);
        return decodeStatusListJwt(response.text).statusList.getStatus(index);
    }

    async function createList(credentialConfigurationId: string) {
        const response = await request(app.getHttpServer())
            .post("/status-lists")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ credentialConfigurationId, bits: 1, capacity: 1000 })
            .expect(201);
        return response.body.id as string;
    }

    async function allocate(
        sessionId: string,
        credentialConfigurationId: string,
    ) {
        const payload = await app
            .get(StatusListService)
            .createEntry(
                { tenantId: "root", id: sessionId } as never,
                credentialConfigurationId,
            );
        return payload.status.status_list.idx;
    }

    function patch(body: Record<string, unknown>, query = "") {
        return request(app.getHttpServer())
            .patch(`/issuer/credentials/${CONFIG}${query}`)
            .set("Authorization", `Bearer ${authToken}`)
            .send(body);
    }

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        await request(app.getHttpServer())
            .put("/status-list-config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ immediateUpdate: true })
            .expect(200);

        const configs = await request(app.getHttpServer())
            .get("/issuer/credentials")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const base = configs.body.find(
            (config: { config?: { format?: string } }) =>
                config.config?.format === "dc+sd-jwt",
        );
        for (const [id, policy] of [
            [CONFIG, POLICY_A],
            [OTHER_CONFIG, POLICY_A],
        ] as const) {
            await request(app.getHttpServer())
                .post("/issuer/credentials")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    ...base,
                    id,
                    statusManagement: true,
                    embeddedDisclosurePolicy: policy,
                })
                .expect(201);
        }

        listId = await createList(CONFIG);
        otherListId = await createList(OTHER_CONFIG);
        indexes = [
            await allocate("disclosure-policy-a", CONFIG),
            await allocate("disclosure-policy-b", CONFIG),
        ];
        otherIndex = await allocate("disclosure-policy-c", OTHER_CONFIG);
    });

    afterAll(async () => {
        await app?.close();
    });

    test("refuses a value other than true or false, changing nothing", async () => {
        const response = await patch(
            { embeddedDisclosurePolicy: POLICY_B },
            "?revokeOnDisclosurePolicyChange=yes",
        ).expect(400);
        expect(response.body.message).toBe(
            "revokeOnDisclosurePolicyChange must be true or false",
        );
        const stored = await request(app.getHttpServer())
            .get(`/issuer/credentials/${CONFIG}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(stored.body.embeddedDisclosurePolicy).toEqual(POLICY_A);
    });

    test("refuses a client limited to other credential configurations, changing nothing", async () => {
        const client = await request(app.getHttpServer())
            .post("/client")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                clientId: "disclosure-policy-limited",
                roles: [Role.Issuances],
                allowedIssuanceConfigs: [OTHER_CONFIG],
            })
            .expect(201);
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                client_id: client.body.clientId,
                client_secret: client.body.clientSecret,
                grant_type: "client_credentials",
            })
            .expect(201);

        await request(app.getHttpServer())
            .patch(
                `/issuer/credentials/${CONFIG}?revokeOnDisclosurePolicyChange=true`,
            )
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .send({ embeddedDisclosurePolicy: POLICY_B })
            .expect(403);

        const stored = await request(app.getHttpServer())
            .get(`/issuer/credentials/${CONFIG}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(stored.body.embeddedDisclosurePolicy).toEqual(POLICY_A);
        for (const index of indexes) {
            expect(await publishedStatus(listId, index)).toBe(0);
        }
    });

    test("keeps the credentials valid when the same policy is set again", async () => {
        await patch(
            {
                embeddedDisclosurePolicy: {
                    values: POLICY_A.values,
                    policy: "allowList",
                },
            },
            "?revokeOnDisclosurePolicyChange=true",
        ).expect(200);
        for (const index of indexes) {
            expect(await publishedStatus(listId, index)).toBe(0);
        }
    });

    test("keeps the credentials valid when the policy changes without the opt-in", async () => {
        await patch({ embeddedDisclosurePolicy: POLICY_B }).expect(200);
        await patch(
            { embeddedDisclosurePolicy: POLICY_A },
            "?revokeOnDisclosurePolicyChange=false",
        ).expect(200);
        await patch({ embeddedDisclosurePolicy: POLICY_B }).expect(200);
        for (const index of indexes) {
            expect(await publishedStatus(listId, index)).toBe(0);
        }
    });

    test("revokes the configuration's credentials when the policy changes with the opt-in", async () => {
        const response = await patch(
            { embeddedDisclosurePolicy: POLICY_A },
            "?revokeOnDisclosurePolicyChange=true",
        ).expect(200);
        expect(response.body.embeddedDisclosurePolicy).toEqual(POLICY_A);

        for (const index of indexes) {
            expect(await publishedStatus(listId, index)).toBe(1);
        }
        expect(await publishedStatus(otherListId, otherIndex)).toBe(0);
    });

    test("revokes a credential issued since the last change when the policy is deleted", async () => {
        const fresh = await allocate("disclosure-policy-d", CONFIG);
        expect(await publishedStatus(listId, fresh)).toBe(0);

        await patch(
            { embeddedDisclosurePolicy: null },
            "?revokeOnDisclosurePolicyChange=true",
        ).expect(200);

        expect(await publishedStatus(listId, fresh)).toBe(1);
        expect(await publishedStatus(otherListId, otherIndex)).toBe(0);
    });
});
