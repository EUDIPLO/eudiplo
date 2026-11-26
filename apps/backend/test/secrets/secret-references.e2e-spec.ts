import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { setupIssuanceTestApp } from "../utils.js";

const receiver = "http://localhost:8788";
const granted = "${env:E2E_ROOT_SHOP_TOKEN}";

describe("Secret references in webhook endpoints, attribute providers and the issuance configuration", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let policyDir: string;

    const api = () => request(app.getHttpServer());
    const post = (path: string, body: unknown) =>
        api()
            .post(path)
            .set("Authorization", `Bearer ${authToken}`)
            .send(body as object);
    const endpoint = (id: string, value: string) => ({
        id,
        name: id,
        url: `${receiver}/${id}`,
        auth: { type: "apiKey", config: { headerName: "x-api-key", value } },
    });

    beforeAll(async () => {
        policyDir = mkdtempSync(join(tmpdir(), "eudiplo-secret-policy-"));
        const policyFile = join(policyDir, "secret-policy.json");
        writeFileSync(
            policyFile,
            JSON.stringify({ tenants: { root: { env: ["E2E_ROOT_*"] } } }),
        );
        process.env.SECRET_POLICY_FILE = policyFile;
        process.env.E2E_ROOT_SHOP_TOKEN = "value-from-env";
        process.env.E2E_OTHER_TOKEN = "not-granted";
        ({ app, authToken } = await setupIssuanceTestApp());
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
        delete process.env.SECRET_POLICY_FILE;
        delete process.env.E2E_ROOT_SHOP_TOKEN;
        delete process.env.E2E_OTHER_TOKEN;
        rmSync(policyDir, { recursive: true, force: true });
    });

    test("stores a granted reference, shows it and sends its value", async () => {
        await post(
            "/issuer/webhook-endpoints",
            endpoint("shop", granted),
        ).expect(201);

        const stored = await api()
            .get("/issuer/webhook-endpoints/shop")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(stored.body.auth.config.value).toBe(granted);

        const headers: Record<string, string>[] = [];
        nock(receiver)
            .post("/shop")
            .reply(async (req: Request) => {
                headers.push(Object.fromEntries(req.headers));
                return [200, ""];
            });
        const offer = await post("/issuer/offer", {
            response_type: "uri",
            credentialConfigurationIds: ["pid-no-key"],
            flow: "pre_authorized_code",
            webhookEndpointId: "shop",
        }).expect(201);
        await api()
            .post(`/session/${offer.body.session}/cancel`)
            .set("Authorization", `Bearer ${authToken}`)
            .send({})
            .expect(204);

        await vi.waitFor(() => expect(headers).toHaveLength(1), {
            timeout: 10_000,
        });
        expect(headers[0]["x-api-key"]).toBe("value-from-env");

        const session = await api()
            .get(`/session/${offer.body.session}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(JSON.stringify(session.body)).not.toContain("value-from-env");
    });

    test("keeps a literal API key write-only", async () => {
        await post(
            "/issuer/webhook-endpoints",
            endpoint("literal", "plain-key"),
        ).expect(201);
        const stored = await api()
            .get("/issuer/webhook-endpoints/literal")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(stored.body.auth.config.value).toBe("<redacted>");
    });

    test("refuses references the tenant's policy does not grant", async () => {
        const res = await post(
            "/issuer/webhook-endpoints",
            endpoint("other", "${env:E2E_OTHER_TOKEN}"),
        ).expect(400);
        expect(JSON.stringify(res.body)).toContain("auth.config.value");
        expect(JSON.stringify(res.body)).not.toContain("not-granted");

        await post("/issuer/attribute-providers", {
            ...endpoint("crm", "${vault:kv/crm#token}"),
        }).expect(400);
        await post("/issuer/attribute-providers", {
            ...endpoint("crm", granted),
        }).expect(201);
    });

    test("checks and shows a reference as the upstream client secret", async () => {
        const current = await api()
            .get("/issuer/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const withSecret = (clientSecret: string) => ({
            ...current.body,
            authorizationServers: [
                {
                    id: "chained-auth",
                    type: "chained",
                    enabled: true,
                    upstream: {
                        issuer: "https://idp.example",
                        clientId: "eudiplo",
                        clientSecret,
                        scopes: ["openid"],
                    },
                    requireDPoP: false,
                },
            ],
        });

        const refused = await post(
            "/issuer/config",
            withSecret("${env:E2E_OTHER_TOKEN}"),
        ).expect(400);
        expect(JSON.stringify(refused.body)).toContain(
            "authorizationServers[0].upstream.clientSecret",
        );

        const stored = await post("/issuer/config", withSecret(granted)).expect(
            201,
        );
        expect(stored.body.authorizationServers[0].upstream.clientSecret).toBe(
            granted,
        );
        const shown = await api()
            .get("/issuer/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(shown.body.authorizationServers[0].upstream.clientSecret).toBe(
            granted,
        );
        expect(JSON.stringify(shown.body)).not.toContain("value-from-env");
    });

    test("refuses a reference in the webhook of a presentation request", async () => {
        const res = await post("/verifier/offer", {
            response_type: "uri",
            requestId: "pid",
            webhook: {
                url: `${receiver}/presentation`,
                auth: endpoint("inline", granted).auth,
            },
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain("webhook.auth.config.value");
    });

    test("refuses a reference in a webhook of a request", async () => {
        const res = await post("/issuer/offer", {
            response_type: "uri",
            credentialConfigurationIds: ["pid-no-key"],
            flow: "pre_authorized_code",
            credentialClaims: {
                "pid-no-key": {
                    type: "webhook",
                    webhook: {
                        url: `${receiver}/inline`,
                        auth: endpoint("inline", granted).auth,
                    },
                },
            },
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain(
            "credentialClaims.pid-no-key.webhook.auth.config.value",
        );
    });
});
