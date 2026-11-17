import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { hashClientSecret, type OidcClient } from "../domain/oidc-client.js";
import { OidcError, SignInNotUsable } from "../domain/oidc-error.js";
import {
    ACR_CROSS_DEVICE,
    ACR_SAME_DEVICE,
    type OidcSignIn,
    OidcSignInStatus,
} from "../domain/oidc-sign-in.js";
import type { IdTokenSigner } from "../ports/id-token-signer.js";
import type { OidcClientRepository } from "../ports/oidc-client.repository.js";
import type {
    OidcSignInChanges,
    OidcSignInRepository,
} from "../ports/oidc-sign-in.repository.js";
import type {
    SignInPresentation,
    SignInPresentationResult,
} from "../ports/sign-in-presentation.js";
import { AuthenticateOidcClient } from "./authenticate-client.js";
import { BuildOidcDiscovery } from "./build-oidc-discovery.js";
import { FinishSignIn, type SignInStep } from "./finish-sign-in.js";
import { PushAuthorizationRequest } from "./push-authorization-request.js";
import { RedeemAuthorizationCode } from "./redeem-authorization-code.js";
import { StartSignIn } from "./start-sign-in.js";

const PUBLIC_URL = "https://eudiplo.example";
const ISSUER = `${PUBLIC_URL}/verifiers/tenant/oidc`;
const REDIRECT = "https://rp.example.com/cb";
const VERIFIER = "a-code-verifier-that-is-long-enough-1234567890";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

class InMemoryClients
    implements Pick<OidcClientRepository, "findForTenant" | "recordSecretUse">
{
    clients = new Map<string, OidcClient>();
    secretUses: string[] = [];
    async findForTenant(tenantId: string, id: string) {
        const client = this.clients.get(id);
        return client?.tenantId === tenantId ? client : null;
    }
    async recordSecretUse(_t: string, _c: string, secretId: string) {
        this.secretUses.push(secretId);
    }
}

class InMemorySignIns implements OidcSignInRepository {
    rows = new Map<string, OidcSignIn>();
    async insert(signIn: OidcSignIn) {
        this.rows.set(signIn.id, { ...signIn });
    }
    async findForTenant(tenantId: string, id: string) {
        const row = this.rows.get(id);
        return row?.tenantId === tenantId ? { ...row } : null;
    }
    async findAuthorizedByCode(tenantId: string, codeHash: string) {
        const row = [...this.rows.values()].find(
            (entry) =>
                entry.tenantId === tenantId &&
                entry.codeHash === codeHash &&
                entry.status === OidcSignInStatus.Authorized,
        );
        return row ? { ...row } : null;
    }
    async transition(
        tenantId: string,
        id: string,
        from: OidcSignInStatus,
        changes: OidcSignInChanges,
    ) {
        const row = this.rows.get(id);
        if (!row || row.tenantId !== tenantId || row.status !== from) {
            return false;
        }
        this.rows.set(id, { ...row, ...changes });
        return true;
    }
    async deleteExpired() {
        return 0;
    }
}

class FakePresentation implements SignInPresentation {
    result_: SignInPresentationResult = { status: "open", crossDevice: false };
    callbackUrl?: string;
    unusable?: string;
    async unusableReason() {
        return this.unusable;
    }
    startFails = false;
    async start(_t: string, _c: string, callbackUrl: string) {
        if (this.startFails) throw new Error("KMS unavailable");
        this.callbackUrl = callbackUrl;
        return {
            sessionId: "presentation-1",
            sameDeviceRequest: "openid4vp://?same",
            crossDeviceRequest: "openid4vp://?cross",
        };
    }
    async result() {
        return this.result_;
    }
    completed(crossDevice: boolean) {
        this.result_ = {
            status: "completed",
            crossDevice,
            responseCode: "response-code",
            credentials: [{ id: "pid", values: [{ given_name: "Ada" }] }],
        };
    }
}

const signer: IdTokenSigner = {
    async sign(_tenantId, claims) {
        return `signed.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    },
    async publicKeys() {
        return [];
    },
    async algorithms() {
        return ["ES384"];
    },
};

function claimsOf(idToken: string): Record<string, unknown> {
    return JSON.parse(
        Buffer.from(idToken.split(".")[1], "base64url").toString(),
    );
}

function codeOf(step: SignInStep): string {
    if (step.type !== "redirect") throw new Error(`got ${step.type}`);
    const url = new URL(step.url);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(url.searchParams.get("state")).toBe("state-1");
    return url.searchParams.get("code")!;
}

describe("OpenID Provider sign-in", () => {
    let clients: InMemoryClients;
    let signIns: InMemorySignIns;
    let presentation: FakePresentation;
    let now: Date;
    let client: OidcClient;
    let authenticate: AuthenticateOidcClient;
    let push: PushAuthorizationRequest;
    let start: StartSignIn;
    let finish: FinishSignIn;
    let redeem: RedeemAuthorizationCode;

    const request = {
        response_type: "code",
        redirect_uri: REDIRECT,
        scope: "openid pid",
        state: "state-1",
        nonce: "nonce-1",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
    };

    beforeEach(() => {
        now = new Date("2026-01-01T10:00:00Z");
        const clock = () => now;
        clients = new InMemoryClients();
        signIns = new InMemorySignIns();
        presentation = new FakePresentation();
        client = {
            id: "client-1",
            tenantId: "tenant",
            name: "Portal",
            redirectUris: [REDIRECT],
            profile: "secure",
            scopes: [{ scope: "pid", presentationConfigId: "pid-config" }],
            secrets: [
                {
                    id: "secret-1",
                    hash: hashClientSecret("s3cret"),
                    createdAt: now,
                },
            ],
        };
        clients.clients.set(client.id, client);
        authenticate = new AuthenticateOidcClient(clients, clock);
        push = new PushAuthorizationRequest(signIns, presentation, clock);
        start = new StartSignIn(
            clients,
            signIns,
            presentation,
            PUBLIC_URL,
            clock,
        );
        finish = new FinishSignIn(signIns, presentation, PUBLIC_URL, clock);
        redeem = new RedeemAuthorizationCode(
            signIns,
            presentation,
            signer,
            PUBLIC_URL,
            clock,
        );
    });

    async function pushedSignIn() {
        const { request_uri } = await push.execute(client, request);
        return start.execute("tenant", {
            client_id: client.id,
            request_uri,
        });
    }

    test("same device: the wallet's redirect to the starting browser issues a code", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        expect(presentation.callbackUrl).toBe(
            `${ISSUER}/sign-in/${signInId}/callback`,
        );
        expect(
            (await finish.view("tenant", signInId, browserSecret)).state,
        ).toBe("waiting");

        presentation.completed(false);
        // The page keeps waiting for the wallet's redirect.
        expect(
            (await finish.view("tenant", signInId, browserSecret)).state,
        ).toBe("waiting");
        expect(
            await finish.fromBrowser("tenant", signInId, browserSecret),
        ).toEqual({ type: "waiting" });

        const code = codeOf(
            await finish.fromWallet(
                "tenant",
                signInId,
                browserSecret,
                "response-code",
            ),
        );
        const tokens = await redeem.execute(client, {
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT,
            code_verifier: VERIFIER,
        });
        const claims = claimsOf(tokens.id_token);
        expect(claims).toMatchObject({
            iss: ISSUER,
            aud: "client-1",
            sub: "presentation-1",
            nonce: "nonce-1",
            acr: ACR_SAME_DEVICE,
            credentials: [{ id: "pid", values: [{ given_name: "Ada" }] }],
        });
        expect(tokens.scope).toBe("openid pid");

        // The code is single use.
        await expect(
            redeem.execute(client, {
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT,
                code_verifier: VERIFIER,
            }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    test("cross device: the starting browser finishes once the wallet presented", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        presentation.completed(true);
        expect(
            (await finish.view("tenant", signInId, browserSecret)).state,
        ).toBe("ready");
        const code = codeOf(
            await finish.fromBrowser("tenant", signInId, browserSecret),
        );
        const tokens = await redeem.execute(client, {
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT,
            code_verifier: VERIFIER,
        });
        expect(claimsOf(tokens.id_token).acr).toBe(ACR_CROSS_DEVICE);
    });

    test("another browser can never finish the sign-in", async () => {
        const { signInId } = await pushedSignIn();
        presentation.completed(true);
        await expect(
            finish.fromBrowser("tenant", signInId, "stolen"),
        ).rejects.toBeInstanceOf(SignInNotUsable);
        await expect(
            finish.fromBrowser("tenant", signInId, undefined),
        ).rejects.toBeInstanceOf(SignInNotUsable);
    });

    test("a wallet that returns the holder to another browser lets the starting one finish as cross-device", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        presentation.completed(false);
        expect(
            await finish.fromWallet(
                "tenant",
                signInId,
                undefined,
                "response-code",
            ),
        ).toEqual({ type: "return-to-browser" });
        expect(
            (await finish.view("tenant", signInId, browserSecret)).state,
        ).toBe("ready");
        codeOf(await finish.fromBrowser("tenant", signInId, browserSecret));
        expect(signIns.rows.get(signInId)?.acr).toBe(ACR_CROSS_DEVICE);
    });

    test("a wrong response_code from another browser changes nothing", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        presentation.completed(false);
        await finish.fromWallet("tenant", signInId, undefined, "guessed");
        expect(
            (await finish.view("tenant", signInId, browserSecret)).state,
        ).toBe("waiting");
    });

    test("a wrong response_code in the starting browser is refused", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        presentation.completed(false);
        await expect(
            finish.fromWallet("tenant", signInId, browserSecret, "guessed"),
        ).rejects.toBeInstanceOf(SignInNotUsable);
    });

    test("acr_values with only same-device refuses a cross-device presentation", async () => {
        const { request_uri } = await push.execute(client, {
            ...request,
            acr_values: ACR_SAME_DEVICE,
        });
        const { signInId, browserSecret } = await start.execute("tenant", {
            client_id: client.id,
            request_uri,
        });
        presentation.completed(true);
        const step = await finish.fromBrowser(
            "tenant",
            signInId,
            browserSecret,
        );
        expect(step.type).toBe("redirect");
        const url = new URL((step as { url: string }).url);
        expect(url.searchParams.get("error")).toBe("access_denied");
        expect(url.searchParams.get("state")).toBe("state-1");
        expect(signIns.rows.get(signInId)?.status).toBe(
            OidcSignInStatus.Failed,
        );
    });

    test("a failed presentation returns access_denied with the reason", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        presentation.result_ = {
            status: "failed",
            crossDevice: true,
            failureReason: "The credential has been revoked",
        };
        const step = await finish.fromBrowser(
            "tenant",
            signInId,
            browserSecret,
        );
        const url = new URL((step as { url: string }).url);
        expect(url.searchParams.get("error")).toBe("access_denied");
        expect(url.searchParams.get("error_description")).toBe(
            "The credential has been revoked",
        );
        expect(url.searchParams.get("iss")).toBe(ISSUER);
    });

    test("an expired sign-in returns access_denied", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        now = new Date(now.getTime() + 16 * 60 * 1000);
        const step = await finish.fromBrowser(
            "tenant",
            signInId,
            browserSecret,
        );
        expect(
            new URL((step as { url: string }).url).searchParams.get("error"),
        ).toBe("access_denied");
    });

    test("a pushed request is used once and expires", async () => {
        const { request_uri } = await push.execute(client, request);
        await start.execute("tenant", { client_id: client.id, request_uri });
        await expect(
            start.execute("tenant", { client_id: client.id, request_uri }),
        ).rejects.toBeInstanceOf(SignInNotUsable);

        const second = await push.execute(client, request);
        now = new Date(now.getTime() + 301 * 1000);
        await expect(
            start.execute("tenant", {
                client_id: client.id,
                request_uri: second.request_uri,
            }),
        ).rejects.toBeInstanceOf(SignInNotUsable);
    });

    test("a pushed request of another client is refused", async () => {
        const { request_uri } = await push.execute(client, request);
        clients.clients.set("client-2", { ...client, id: "client-2" });
        await expect(
            start.execute("tenant", { client_id: "client-2", request_uri }),
        ).rejects.toBeInstanceOf(SignInNotUsable);
    });

    test("a secure client must push; a basic client may not have to", async () => {
        await expect(
            start.execute("tenant", { client_id: client.id, ...request }),
        ).rejects.toBeInstanceOf(SignInNotUsable);

        client.profile = "basic";
        const started = await start.execute("tenant", {
            client_id: client.id,
            ...request,
        });
        expect(signIns.rows.get(started.signInId)?.status).toBe(
            OidcSignInStatus.Pending,
        );
    });

    test("a basic client's invalid request is redirected with state", async () => {
        client.profile = "basic";
        const error = await start
            .execute("tenant", {
                client_id: client.id,
                ...request,
                scope: "openid profile email",
            })
            .catch((caught) => caught);
        expect(error).toBeInstanceOf(OidcError);
        expect(error.code).toBe("invalid_scope");
        expect(error.redirect).toEqual({
            redirectUri: REDIRECT,
            state: "state-1",
        });
    });

    test("PAR refuses a scope whose config cannot verify a sign-in", async () => {
        presentation.unusable = "defines transaction data";
        await expect(push.execute(client, request)).rejects.toMatchObject({
            code: "invalid_scope",
        });
    });

    test("discovery advertises the signer's algorithm", async () => {
        const discovery = new BuildOidcDiscovery(
            { existsForTenant: async () => true },
            signer,
            PUBLIC_URL,
        );
        expect(
            (await discovery.execute("tenant"))
                .id_token_signing_alg_values_supported,
        ).toEqual(["ES384"]);
    });

    test("a failure after the presentation started is not reported as server_error", async () => {
        const { request_uri } = await push.execute(client, request);
        const transition = signIns.transition.bind(signIns);
        signIns.transition = async (tenantId, id, from, changes) => {
            if (changes.presentationSessionId) throw new Error("database down");
            return transition(tenantId, id, from, changes);
        };
        await expect(
            start.execute("tenant", { client_id: client.id, request_uri }),
        ).rejects.toThrow("database down");
    });

    test("a presentation that cannot be requested fails the sign-in with server_error", async () => {
        presentation.startFails = true;
        const { request_uri } = await push.execute(client, request);
        const error = await start
            .execute("tenant", { client_id: client.id, request_uri })
            .catch((caught) => caught);
        expect(error).toMatchObject({
            code: "server_error",
            redirect: { redirectUri: REDIRECT, state: "state-1" },
        });
        expect([...signIns.rows.values()][0].status).toBe(
            OidcSignInStatus.Failed,
        );
    });

    test("only one of two concurrent completions gets a code", async () => {
        const { signInId, browserSecret } = await pushedSignIn();
        presentation.completed(true);
        const results = await Promise.allSettled([
            finish.fromBrowser("tenant", signInId, browserSecret),
            finish.fromBrowser("tenant", signInId, browserSecret),
        ]);
        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const rejected = results.find(
            (result) => result.status === "rejected",
        ) as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(SignInNotUsable);
    });

    describe("pushed authorization request", () => {
        test.each([
            ["another client_id", { client_id: "client-2" }],
            ["a pushed request_uri", { request_uri: "urn:x" }],
        ])("refuses %s with invalid_request", async (_, override) => {
            await expect(
                push.execute(client, { ...request, ...override }),
            ).rejects.toMatchObject({ code: "invalid_request" });
        });

        test("returns validation errors in the response, never by redirect", async () => {
            const error = await push
                .execute(client, { ...request, scope: "openid email" })
                .catch((caught) => caught);
            expect(error).toBeInstanceOf(OidcError);
            expect(error.code).toBe("invalid_scope");
            expect(error.redirect).toBeUndefined();
        });
    });

    describe("token endpoint", () => {
        async function authorizedCode() {
            const { signInId, browserSecret } = await pushedSignIn();
            presentation.completed(true);
            return codeOf(
                await finish.fromBrowser("tenant", signInId, browserSecret),
            );
        }

        test.each([
            ["a wrong code_verifier", { code_verifier: "wrong" }],
            ["a missing code_verifier", { code_verifier: undefined }],
            ["another redirect_uri", { redirect_uri: "https://x.example/cb" }],
        ])("refuses %s", async (_, override) => {
            const code = await authorizedCode();
            await expect(
                redeem.execute(client, {
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: REDIRECT,
                    code_verifier: VERIFIER,
                    ...override,
                }),
            ).rejects.toMatchObject({ code: "invalid_grant" });
        });

        test("refuses another client's code", async () => {
            const code = await authorizedCode();
            await expect(
                redeem.execute(
                    { ...client, id: "client-2" },
                    {
                        grant_type: "authorization_code",
                        code,
                        redirect_uri: REDIRECT,
                        code_verifier: VERIFIER,
                    },
                ),
            ).rejects.toMatchObject({ code: "invalid_grant" });
        });

        test("refuses an expired code", async () => {
            const code = await authorizedCode();
            now = new Date(now.getTime() + 61 * 1000);
            await expect(
                redeem.execute(client, {
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: REDIRECT,
                    code_verifier: VERIFIER,
                }),
            ).rejects.toMatchObject({ code: "invalid_grant" });
        });

        test("refuses a request without code", async () => {
            await expect(
                redeem.execute(client, { grant_type: "authorization_code" }),
            ).rejects.toMatchObject({ code: "invalid_request" });
        });

        test("refuses a code whose presentation is gone", async () => {
            const code = await authorizedCode();
            presentation.result_ = { status: "expired", crossDevice: true };
            await expect(
                redeem.execute(client, {
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: REDIRECT,
                    code_verifier: VERIFIER,
                }),
            ).rejects.toMatchObject({ code: "invalid_grant" });
        });

        test("refuses other grant types", async () => {
            await expect(
                redeem.execute(client, { grant_type: "refresh_token" }),
            ).rejects.toMatchObject({ code: "unsupported_grant_type" });
        });
    });

    describe("client authentication", () => {
        test("accepts the secret and records its use", async () => {
            await expect(
                authenticate.execute("tenant", {
                    clientId: "client-1",
                    clientSecret: "s3cret",
                }),
            ).resolves.toMatchObject({ id: "client-1" });
            expect(clients.secretUses).toEqual(["secret-1"]);
        });

        test.each([
            ["a wrong secret", { clientId: "client-1", clientSecret: "x" }],
            ["an unknown client", { clientId: "nope", clientSecret: "s3cret" }],
            ["no secret", { clientId: "client-1" }],
        ])("refuses %s with invalid_client", async (_, credentials) => {
            await expect(
                authenticate.execute("tenant", credentials),
            ).rejects.toMatchObject({
                code: "invalid_client",
                clientAuthenticationFailed: true,
            });
        });

        test("refuses a client of another tenant", async () => {
            await expect(
                authenticate.execute("other-tenant", {
                    clientId: "client-1",
                    clientSecret: "s3cret",
                }),
            ).rejects.toMatchObject({ code: "invalid_client" });
        });
    });
});
