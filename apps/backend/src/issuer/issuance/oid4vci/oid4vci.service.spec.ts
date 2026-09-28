import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import { describe, expect, it, vi } from "vitest";
import { HandleCredentialNotification } from "./application/handle-credential-notification.js";
import { Oid4vciService } from "./oid4vci.service.js";

describe("Oid4vciService internal JWKS resolution", () => {
    it("uses INTERNAL_URL only for the built-in authorization server", () => {
        const service = Object.assign(
            Object.create(Oid4vciService.prototype) as Oid4vciService,
            {
                settings: { internalUrl: "http://127.0.0.1:3000/" },
                authzService: {
                    getAuthzIssuer: vi.fn(
                        (tenantId: string) =>
                            `https://issuer.example/issuers/${tenantId}`,
                    ),
                },
            },
        );
        const authorizationServers = [
            {
                issuer: "https://issuer.example/issuers/acme",
                jwks_uri:
                    "https://issuer.example/.well-known/jwks.json/issuers/acme",
            },
            {
                issuer: "https://external.example",
                jwks_uri: "https://external.example/jwks",
            },
        ] as AuthorizationServerMetadata[];

        const resolvedAuthorizationServers = service[
            "getAuthorizationServersForResourceVerification"
        ]("acme", authorizationServers);

        expect(resolvedAuthorizationServers).toEqual([
            {
                issuer: "https://issuer.example/issuers/acme",
                jwks_uri:
                    "http://127.0.0.1:3000/.well-known/jwks.json/issuers/acme",
            },
            {
                issuer: "https://external.example",
                jwks_uri: "https://external.example/jwks",
            },
        ]);
        expect(authorizationServers[0].jwks_uri).toBe(
            "https://issuer.example/.well-known/jwks.json/issuers/acme",
        );
    });
});

describe("OID4VCI notification endpoint lookup", () => {
    function setup(lookupError?: Error | null) {
        const session = {
            id: "session",
            tenantId: "tenant",
            webhookEndpointId: "endpoint",
        };
        const endpoint = {
            url: "https://webhook.example",
            auth: { type: "none" },
        };
        const notification = {
            id: "notification",
            event: "credential_accepted",
            credentialConfigurationId: "pid",
        };
        const order: string[] = [];
        const publish = vi.fn(async () => {
            order.push("publish");
        });
        const changeState = vi.fn(async () => {
            order.push("state");
        });
        const logError = vi.fn();
        const lookup = vi.fn(async () => {
            order.push("lookup");
            if (lookupError) throw lookupError;
            return lookupError === null ? null : endpoint;
        });
        const service = Object.assign(
            Object.create(Oid4vciService.prototype) as Oid4vciService,
            {
                issuanceService: {
                    getIssuanceConfiguration: vi.fn().mockResolvedValue({}),
                },
                settings: { publicUrl: "https://issuer.example" },
                metadata: {
                    getIssuer: vi.fn(),
                    getResourceServer: () => ({
                        verifyResourceRequest: vi.fn().mockResolvedValue({
                            tokenPayload: { sub: "session" },
                        }),
                    }),
                    issuerMetadata: vi.fn().mockResolvedValue({
                        authorizationServers: [],
                        credentialIssuer: {
                            credential_issuer: "https://issuer.example",
                        },
                    }),
                },
                sessionStore: {
                    getForTenant: vi.fn().mockResolvedValue(session),
                },
                traceService: { getSpan: () => undefined },
                handleCredentialNotification: new HandleCredentialNotification(
                    {
                        execute: vi.fn(async () => {
                            order.push("record");
                            return notification;
                        }),
                    },
                    { findForTenant: lookup },
                    { publish },
                    { execute: changeState },
                ),
                auditLogger: { logError },
            },
        );
        const execute = () =>
            service.handleNotification(
                {
                    method: "POST",
                    url: "/notification",
                    headers: {},
                    contentType: "application/json",
                    body: {},
                },
                {
                    notification_id: "notification",
                    event: "credential_accepted",
                },
                "tenant",
            );
        return {
            execute,
            publish,
            changeState,
            logError,
            lookup,
            order,
            session,
            endpoint,
            notification,
        };
    }

    it("propagates storage failures without completing the session", async () => {
        const failure = new Error("database unavailable");
        const test = setup(failure);
        await expect(test.execute()).rejects.toBe(failure);
        expect(test.publish).not.toHaveBeenCalled();
        expect(test.changeState).not.toHaveBeenCalled();
        expect(test.logError).toHaveBeenCalledOnce();
    });

    it("still completes when the configured endpoint no longer exists", async () => {
        const test = setup(null);
        await expect(test.execute()).resolves.toBeUndefined();
        expect(test.lookup).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            "endpoint",
        );
        expect(test.publish).not.toHaveBeenCalled();
        expect(test.changeState).toHaveBeenCalledWith(
            test.session,
            "completed",
        );
        expect(test.order).toEqual(["record", "lookup", "state"]);
    });

    it("persists, publishes, and changes state in that order", async () => {
        const test = setup();
        await test.execute();
        expect(test.publish).toHaveBeenCalledWith(
            test.endpoint,
            test.session,
            test.notification,
        );
        expect(test.order).toEqual(["record", "lookup", "publish", "state"]);
    });
});
