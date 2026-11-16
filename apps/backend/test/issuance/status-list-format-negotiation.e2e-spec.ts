import { INestApplication } from "@nestjs/common";
import { Sign1 } from "@owf/cose";
import { decodeProtectedHeader } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { IssuanceTestContext, setupIssuanceTestApp } from "../utils.js";
import {
    createKeyChain,
    deleteKeyChain,
    expectCoseSign1SignedWithX5chain,
    expectJwsSignedWithX5c,
} from "../utils-ec.js";

function parseBinary(
    res: NodeJS.ReadableStream,
    callback: (err: Error | null, body: Buffer) => void,
) {
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
    res.on("error", (err) => callback(err, Buffer.alloc(0)));
}

describe("Status List - Token Format Negotiation", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let listId: string;

    beforeAll(async () => {
        const ctx: IssuanceTestContext = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        const createdList = await request(app.getHttpServer())
            .post("/status-lists")
            .set("Authorization", `Bearer ${authToken}`)
            .send({})
            .expect(201);

        listId = createdList.body.id;
        expect(listId).toBeDefined();
    });

    afterAll(async () => {
        if (app) {
            await app?.close();
        }
    });

    test("returns JWT by default", () => {
        return request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${listId}`)
            .expect((response) => {
                expect(response.headers["content-type"]).toContain(
                    "application/statuslist+jwt",
                );
                expect(typeof response.text).toBe("string");

                const header = decodeProtectedHeader(response.text);
                expect(header.typ).toBe("statuslist+jwt");
            })
            .expect(200);
    });

    test("returns CWT when Accept requests application/statuslist+cwt", () => {
        return request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${listId}`)
            .set("Accept", "application/statuslist+cwt")
            .buffer(true)
            .parse(parseBinary)
            .expect((response) => {
                expect(response.headers["content-type"]).toContain(
                    "application/statuslist+cwt",
                );

                expect(Buffer.isBuffer(response.body)).toBe(true);
                expect(response.body.length).toBeGreaterThan(32);
                // COSE_Sign1 with CBOR tag 18 starts with 0xd2
                expect(response.body[0]).toBe(0xd2);
            })
            .expect(200);
    });

    test("returns CWT when Content-Type requests application/statuslist+cwt", () => {
        return request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${listId}`)
            .set("Content-Type", "application/statuslist+cwt")
            .buffer(true)
            .parse(parseBinary)
            .expect((response) => {
                expect(response.headers["content-type"]).toContain(
                    "application/statuslist+cwt",
                );

                expect(Buffer.isBuffer(response.body)).toBe(true);
                expect(response.body.length).toBeGreaterThan(32);
                // COSE_Sign1 with CBOR tag 18 starts with 0xd2
                expect(response.body[0]).toBe(0xd2);
            })
            .expect(200);
    });

    test("returns the same cached CWT across repeated requests", async () => {
        const firstResponse = await request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${listId}`)
            .set("Accept", "application/statuslist+cwt")
            .buffer(true)
            .parse(parseBinary)
            .expect(200);

        const secondResponse = await request(app.getHttpServer())
            .get(`/issuers/root/status-management/status-list/${listId}`)
            .set("Accept", "application/statuslist+cwt")
            .buffer(true)
            .parse(parseBinary)
            .expect(200);

        expect(firstResponse.headers["content-type"]).toContain(
            "application/statuslist+cwt",
        );
        expect(secondResponse.headers["content-type"]).toContain(
            "application/statuslist+cwt",
        );
        expect(Buffer.compare(firstResponse.body, secondResponse.body)).toBe(0);
    });

    test.each(["ES384", "ES512"] as const)(
        "signs JWT and CWT with the algorithm of an %s key chain",
        async (alg) => {
            const keyChainId = await createKeyChain(app, authToken, {
                usageType: KeyUsageType.StatusList,
                alg,
            });
            let listId: string | undefined;
            try {
                const list = await request(app.getHttpServer())
                    .post("/status-lists")
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({ keyChainId })
                    .expect(201);
                listId = list.body.id;
                const url = `/issuers/root/status-management/status-list/${listId}`;

                const jwt = await request(app.getHttpServer())
                    .get(url)
                    .expect(200);
                const payload = await expectJwsSignedWithX5c(jwt.text, alg);
                expect(payload.status_list).toBeDefined();
                // The kid as the key chain publishes it, next to the x5c.
                const keyChain = await request(app.getHttpServer())
                    .get(`/key-chain/${keyChainId}`)
                    .set("Authorization", `Bearer ${authToken}`)
                    .expect(200);
                expect(decodeProtectedHeader(jwt.text).kid).toBe(
                    keyChain.body.activePublicKey.kid ?? keyChainId,
                );

                const cwt = await request(app.getHttpServer())
                    .get(url)
                    .set("Accept", "application/statuslist+cwt")
                    .buffer(true)
                    .parse(parseBinary)
                    .expect(200);
                expectCoseSign1SignedWithX5chain(
                    Sign1.decode(new Uint8Array(cwt.body)),
                    alg,
                );
            } finally {
                // Other tests use the default status list key chain.
                if (listId) {
                    await request(app.getHttpServer())
                        .delete(`/status-lists/${listId}`)
                        .set("Authorization", `Bearer ${authToken}`)
                        .expect(204);
                }
                await deleteKeyChain(app, authToken, keyChainId);
            }
        },
    );
});
