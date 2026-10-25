import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Openid4vpClient } from "@openid4vc/openid4vp";
import { decodeJwt, decodeProtectedHeader } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import {
    callbacks,
    createTestFetch,
    issuerStateOf,
    readConfig,
    setupIssuanceTestApp,
} from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

/**
 * The presentation step of the Interactive Authorization Endpoint puts the
 * client_id into the response and the request object is fetched later. When
 * the tenant's default access key chain changes in between, the request
 * object must still be signed with the key chain the client_id names.
 */
describe("OID4VP request object of an existing session (e2e)", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let client: Openid4vpClient;
    const tenantId = "root";
    const configFolder = resolve(__dirname + "/../fixtures");

    const api = () => request(app.getHttpServer());

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        await api()
            .post("/trust-list")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<TrustListCreateDto>(
                    join(configFolder, "haip/trust-lists/pid-tl.json"),
                ),
            )
            .expect(201);

        // Start with a single self-signed access key chain, so a key chain
        // created later outranks it as the default.
        const fixtureAccess = readConfig<KeyChainImportDto>(
            join(configFolder, "haip/key-chains/access.json"),
        );
        await api()
            .delete(`/key-chain/${fixtureAccess.id}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(204);

        const host = app.get(ConfigService).getOrThrow<string>("PUBLIC_URL");
        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    async function createAccessKeyChain(
        type: "standalone" | "internalChain",
    ): Promise<string> {
        const created = await api()
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ usageType: "access", type })
            .expect(201);
        return created.body.id;
    }

    /** The leaf of a key chain's active certificate as base64 DER. */
    async function leafOf(keyChainId: string): Promise<string> {
        const keyChain = await app
            .get(KeyChainService)
            .getEntity(tenantId, keyChainId);
        return keyChain.activeCertificate
            .match(
                /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
            )![1]
            .replaceAll(/\s/g, "");
    }

    /** Starts the presentation step of an interactive authorization. */
    async function startPresentation(): Promise<{
        initial: request.Response;
        params: URLSearchParams;
    }> {
        const offer = await api()
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["citizen"],
                flow: "authorization_code",
            })
            .expect(201);
        const initial = await api()
            .post(`/issuers/${tenantId}/authorize/interactive`)
            .send({
                response_type: "code",
                client_id: "test-wallet",
                interaction_types_supported: "openid4vp_presentation",
                issuer_state: issuerStateOf(offer.body.uri),
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            })
            .expect(200);
        expect(initial.body.type).toBe("openid4vp_presentation");
        return {
            initial,
            params: new URLSearchParams(initial.body.openid4vp_request.request),
        };
    }

    const x509Hash = (leaf: string) =>
        `x509_hash:${createHash("sha256")
            .update(Buffer.from(leaf, "base64"))
            .digest("base64url")}`;

    /** IDs of the access key chains the first test creates. */
    let pinned: string;
    let internalChain: string;

    test("signs the request object with the key chain of the client_id after the default changed", async () => {
        pinned = await createAccessKeyChain("standalone");

        const { initial, params } = await startPresentation();
        const clientId = params.get("client_id")!;
        const pinnedLeaf = await leafOf(pinned);
        expect(clientId).toBe(x509Hash(pinnedLeaf));

        // An internal chain outranks the self-signed key chain, so it is the
        // tenant's default access key chain from now on.
        const newDefault = await createAccessKeyChain("internalChain");
        internalChain = newDefault;
        expect(await leafOf(newDefault)).not.toBe(pinnedLeaf);

        const requestUri = new URL(params.get("request_uri")!);
        const fetched = await api()
            .get(requestUri.pathname)
            .trustLocalhost()
            .expect(200);
        const requestObject = fetched.text;
        expect(decodeJwt(requestObject).client_id).toBe(clientId);
        expect(decodeProtectedHeader(requestObject).x5c?.[0]).toBe(pinnedLeaf);

        // A wallet accepts it: the client_id matches the x5c leaf.
        const parsed = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: `openid4vp://?${initial.body.openid4vp_request.request}`,
        });
        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: parsed.params,
            responseMode: { type: "direct_post" },
        });
        expect(resolved.authorizationRequestPayload.client_id).toBe(clientId);
    });

    test("signs with the tenant's default access key chain over the one picked by rule", async () => {
        // The internal chain outranks it, so only the setting makes it the default.
        await api()
            .put("/key-chain/access/default")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ defaultAccessKeyChainId: pinned })
            .expect(200);
        try {
            const pinnedLeaf = await leafOf(pinned);
            const { params } = await startPresentation();
            expect(params.get("client_id")).toBe(x509Hash(pinnedLeaf));

            const fetched = await api()
                .get(new URL(params.get("request_uri")!).pathname)
                .trustLocalhost()
                .expect(200);
            expect(decodeProtectedHeader(fetched.text).x5c?.[0]).toBe(
                pinnedLeaf,
            );
        } finally {
            await api()
                .put("/key-chain/access/default")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ defaultAccessKeyChainId: null })
                .expect(200);
        }

        // Without the setting, the rule picks the internal chain again.
        const { params } = await startPresentation();
        expect(params.get("client_id")).toBe(
            x509Hash(await leafOf(internalChain)),
        );
    });
});
