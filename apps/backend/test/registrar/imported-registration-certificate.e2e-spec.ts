import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decodeJwt } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    createPresentationRequest,
    setupPresentationTestApp,
} from "../utils.js";

/** Unsigned JWT; EUDIPLO only decodes registration certificates. */
function unsignedJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none", typ: "rc-rp+jwt" })}.${encode(payload)}.`;
}

/**
 * An imported registration certificate (`registration_cert.jwt`) needs no
 * registrar configuration: it is checked when the configuration is saved and
 * attached to the request object as is. The tenant of this suite has no
 * registrar configuration.
 */
describe("Imported registration certificate without a registrar (e2e)", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let credentialQuery: Record<string, any>;
    let vct: string;

    const api = () => request(app.getHttpServer());

    const certificate = (claims: string[][]) =>
        unsignedJwt({
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            credentials: [
                {
                    format: "dc+sd-jwt",
                    meta: { vct_values: [vct] },
                    claim: claims.map((path) => ({ path })),
                },
            ],
        });

    const storeConfig = (id: string, jwt: string) =>
        api()
            .post("/verifier/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id,
                dcql_query: { credentials: [credentialQuery] },
                registration_cert: { jwt },
            });

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        const fixture = (
            await api()
                .get("/verifier/config/pid-no-hook")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body;
        const fixtureQuery = fixture.dcql_query.credentials[0];
        // One type, so the certificate below covers the query.
        credentialQuery = {
            ...fixtureQuery,
            meta: { vct_values: [fixtureQuery.meta.vct_values[0]] },
            claims: [{ path: ["given_name"] }, { path: ["family_name"] }],
        };
        vct = credentialQuery.meta.vct_values[0].replace(
            "<TENANT_URL>",
            `${app.get(ConfigService).getOrThrow("PUBLIC_URL")}/issuers/root`,
        );
    });

    afterAll(async () => {
        await app?.close();
    });

    test("refuses to store a certificate that does not cover the request", async () => {
        const res = await storeConfig(
            "imported-overasking",
            certificate([["given_name"]]),
        ).expect(400);
        expect(JSON.stringify(res.body)).toContain(
            "Registration certificate does not authorize the requested DCQL credentials",
        );

        await api()
            .get("/verifier/config/imported-overasking")
            .set("Authorization", `Bearer ${authToken}`)
            .expect((r) => expect(r.status).not.toBe(200));
    });

    test("refuses to store an expired certificate", async () => {
        const expired = unsignedJwt({
            exp: Math.floor(Date.now() / 1000) - 3600,
            credentials: [],
        });
        const res = await storeConfig("imported-expired", expired).expect(400);
        expect(JSON.stringify(res.body)).toContain(
            "Registration certificate is expired",
        );
    });

    test("attaches a certificate that lists the claims in another order", async () => {
        const jwt = certificate([["family_name"], ["given_name"]]);
        await storeConfig("imported-reordered", jwt).expect(201);

        const offer = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "imported-reordered",
        });
        expect(offer.status).toBe(201);
        const requestUri = new URLSearchParams(offer.body.uri).get(
            "request_uri",
        )!;
        const requestObject = await api()
            .get(new URL(requestUri).pathname)
            .trustLocalhost()
            .expect(200);

        expect(decodeJwt(requestObject.text).verifier_info).toEqual([
            { format: "registration_cert", data: jwt },
        ]);
    });
});
