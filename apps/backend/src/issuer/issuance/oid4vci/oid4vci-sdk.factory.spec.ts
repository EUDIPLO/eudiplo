import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpService } from "@nestjs/axios";
import {
    type AuthorizationServerMetadata,
    clientAuthenticationNone,
    SupportedAuthenticationScheme,
} from "@openid4vc/oauth2";
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
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import { Oid4vciSdkFactory } from "./oid4vci-sdk.factory.js";

/** Policy with the 9.0 defaults: HTTPS only, no private addresses. */
const policy = (config: Record<string, boolean> = {}) =>
    new OutboundUrlPolicyService({
        get: vi.fn(
            (key: string, fallback?: unknown) => config[key] ?? fallback,
        ),
    } as never);

function factory(
    issuanceConfig: object | Error,
    outboundUrlPolicy = policy(),
    publicUrl = "https://issuer.example",
) {
    const keyChainService = {
        getKid: vi.fn().mockResolvedValue("default-key"),
        getPublicKey: vi.fn(async (_format, _tenant, keyId: string) => ({
            kty: "EC",
            kid: keyId,
        })),
    };
    const sdk = new Oid4vciSdkFactory(
        {
            keyChainService,
            getCallbackContext: () => ({
                clientAuthentication: clientAuthenticationNone({
                    clientId: "eudiplo",
                }),
            }),
        } as any,
        {
            getIssuanceConfiguration: vi.fn(async () => {
                if (issuanceConfig instanceof Error) throw issuanceConfig;
                return issuanceConfig;
            }),
        } as any,
        outboundUrlPolicy,
        new HttpService(axios.create()),
        { publicUrl },
    );
    const resolveLocalJwks = (jwksUri: string) =>
        (sdk as any).resolveLocalJwks("tenant-1", jwksUri);
    return { sdk, resolveLocalJwks, keyChainService };
}

const LOCAL_JWKS =
    "https://issuer.example/.well-known/jwks.json/issuers/tenant-1";

describe("Oid4vciSdkFactory local JWKS", () => {
    it("publishes the access token key of the built-in authorization server", async () => {
        const { resolveLocalJwks } = factory({
            signingKeyId: "issuance-key",
            authorizationServers: [
                {
                    type: "built-in",
                    id: "built-in",
                    token: { signingKeyId: "as-key" },
                },
            ],
        });

        await expect(resolveLocalJwks(LOCAL_JWKS)).resolves.toEqual({
            keys: [{ kty: "EC", kid: "as-key" }],
        });
    });

    it("falls back to the issuance key and the tenant default", async () => {
        await expect(
            factory({
                signingKeyId: "issuance-key",
                authorizationServers: [{ type: "built-in", id: "built-in" }],
            }).resolveLocalJwks(LOCAL_JWKS),
        ).resolves.toEqual({ keys: [{ kty: "EC", kid: "issuance-key" }] });
        await expect(
            factory(new Error("not configured")).resolveLocalJwks(LOCAL_JWKS),
        ).resolves.toEqual({ keys: [{ kty: "EC", kid: "default-key" }] });
    });

    it("leaves foreign JWKS URIs to the library", async () => {
        await expect(
            factory({}).resolveLocalJwks("https://external.example/jwks"),
        ).resolves.toBeUndefined();
    });
});

/**
 * Real requests against a local authorization server: JWKS and token
 * introspection requests of the resource server go through the outbound URL
 * policy, and only EUDIPLO's own origins are exempt.
 */
describe("Oid4vciSdkFactory resource server requests", () => {
    let server: Server;
    let localhost: string;
    let loopbackIp: string;
    let requests: { method?: string; url?: string; body: string }[];

    beforeAll(async () => {
        server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => {
                body += chunk;
            });
            request.on("end", () => {
                requests.push({
                    method: request.method,
                    url: request.url,
                    body,
                });
                response.setHeader("content-type", "application/json");
                if (request.url === "/introspect") {
                    // Most authorization servers require client authentication.
                    response.statusCode = 401;
                    response.end(JSON.stringify({ error: "invalid_client" }));
                    return;
                }
                response.end(JSON.stringify({ keys: [] }));
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        localhost = `http://localhost:${port}`;
        loopbackIp = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        requests = [];
    });

    const issuer = "https://as.example";
    const base64url = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    /** An access token that parses; its signature is never checked here. */
    const accessToken = [
        base64url({ alg: "ES256", typ: "at+jwt" }),
        base64url({
            iss: issuer,
            aud: "https://issuer.example/issuers/tenant-1",
            sub: "wallet",
            jti: "token-1",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
        }),
        "c2ln",
    ].join(".");

    const verify = (
        sdk: Oid4vciSdkFactory,
        token: string,
        authorizationServer: Partial<AuthorizationServerMetadata>,
    ) =>
        sdk.resourceServer("tenant-1").verifyResourceRequest({
            authorizationServers: [
                {
                    issuer,
                    ...authorizationServer,
                } as AuthorizationServerMetadata,
            ],
            request: {
                url: "https://issuer.example/issuers/tenant-1/credential",
                method: "POST",
                headers: new Headers({ authorization: `Bearer ${token}` }),
            },
            resourceServer: "https://issuer.example/issuers/tenant-1",
            allowedAuthenticationSchemes: [
                SupportedAuthenticationScheme.Bearer,
            ],
        });

    it("fetches the JWKS of other authorization servers under the policy", async () => {
        const { sdk } = factory({});
        await expect(
            verify(sdk, accessToken, { jwks_uri: `${loopbackIp}/jwks` }),
        ).rejects.toThrow("must use HTTPS");
        expect(requests).toEqual([]);

        const permissive = factory(
            {},
            policy({
                OUTBOUND_URL_ALLOW_HTTP: true,
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
            }),
        ).sdk;
        // The empty key set fails verification after the request.
        await expect(
            verify(permissive, accessToken, { jwks_uri: `${loopbackIp}/jwks` }),
        ).rejects.toThrow();
        expect(requests).toMatchObject([{ method: "GET", url: "/jwks" }]);
    });

    it("exempts JWKS on EUDIPLO's own origin, as of the chained authorization server", async () => {
        const { sdk } = factory({}, policy(), localhost);
        const jwksUri = `${localhost}/.well-known/jwks.json/issuers/tenant-1/chained-as`;
        await expect(
            verify(sdk, accessToken, { jwks_uri: jwksUri }),
        ).rejects.toThrow();
        expect(requests).toMatchObject([
            {
                method: "GET",
                url: "/.well-known/jwks.json/issuers/tenant-1/chained-as",
            },
        ]);
    });

    it("sends token introspection requests under the policy", async () => {
        const introspection = {
            introspection_endpoint: `${loopbackIp}/introspect`,
        };
        await expect(
            verify(factory({}).sdk, "opaque-token", introspection),
        ).rejects.toThrow("Could not verify token");
        expect(requests).toEqual([]);

        const permissive = factory(
            {},
            policy({
                OUTBOUND_URL_ALLOW_HTTP: true,
                OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: true,
            }),
        ).sdk;
        await expect(
            verify(permissive, "opaque-token", introspection),
        ).rejects.toThrow("Could not verify token");
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: "POST",
            url: "/introspect",
        });
        expect(new URLSearchParams(requests[0].body).get("token")).toBe(
            "opaque-token",
        );
    });
});
