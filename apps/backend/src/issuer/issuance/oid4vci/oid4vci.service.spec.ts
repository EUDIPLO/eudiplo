import {
    BadRequestException,
    ConflictException,
    HttpException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SessionNotFound } from "../../../session/application/session-errors.js";
import { CredentialClaimsResolutionError } from "../../configuration/credentials/domain/credential-claims.js";
import {
    CorrelateCredentialTokenSession,
    CredentialSessionAuthorizationDenied,
} from "./application/correlate-credential-token-session.js";
import { HandleCredentialNotification } from "./application/handle-credential-notification.js";
import {
    CredentialNotificationNotFound,
    RecordCredentialNotification,
} from "./application/record-credential-notification.js";
import {
    CredentialAuthorizationError,
    ResolveAuthorizedCredentialConfiguration,
} from "./application/resolve-authorized-credential-configuration.js";
import { ResolveCredentialProofs } from "./application/resolve-credential-proofs.js";
import {
    AuthorizationServerMetadataUnavailable,
    AuthorizationServerNotConfigured,
} from "./domain/authorization-server-errors.js";
import { InvalidCredentialOffer } from "./domain/credential-offer-errors.js";
import { InvalidCredentialProof } from "./domain/credential-proof-errors.js";
import { CredentialRequestException } from "./exceptions/index.js";
import { Oid4vciService } from "./oid4vci.service.js";
import type { Oid4vciRequestContext } from "./request-context.js";

const issuerMetadata = {
    authorizationServers: [],
    credentialIssuer: { credential_issuer: "https://issuer.example" },
};

function service(overrides: Record<string, unknown>): Oid4vciService {
    return Object.assign(
        Object.create(Oid4vciService.prototype) as Oid4vciService,
        {
            logger: { debug: vi.fn(), warn: vi.fn() },
            traceService: { getSpan: () => undefined },
            sdk: { issuer: vi.fn() },
            buildIssuerMetadata: {
                execute: vi.fn().mockResolvedValue(issuerMetadata),
            },
            ...overrides,
        },
    );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("expected a rejection");
}

function protocolError(error: unknown) {
    expect(error).toBeInstanceOf(CredentialRequestException);
    return (error as HttpException).getResponse();
}

describe("Oid4vciService credential request error mapping", () => {
    const request: Oid4vciRequestContext = {
        method: "POST",
        url: "/issuers/tenant/vci/credential",
        headers: { authorization: "DPoP access-token" },
        contentType: "application/json",
        body: { credential_configuration_id: "pid", proofs: {} },
    };

    function setup(overrides: {
        resolveSession?: () => Promise<unknown>;
        issue?: () => Promise<unknown>;
        authorizationDetails?: unknown;
        updateForTenant?: ReturnType<typeof vi.fn>;
        executeFrom?: ReturnType<typeof vi.fn>;
        keyAttestationsRequired?: Record<string, string[]>;
    }) {
        const session = {
            id: "session",
            tenantId: "tenant",
            notifications: [],
        };
        return service({
            changeSessionState: {
                executeFrom:
                    overrides.executeFrom ?? vi.fn().mockResolvedValue(true),
            },
            sdk: {
                issuer: () => ({
                    getKnownCredentialConfigurationsSupported: () => ({
                        pid: {},
                    }),
                    parseCredentialRequest: () => ({
                        proofs: { jwt: ["proof-jwt"] },
                        credentialConfigurationId: "pid",
                    }),
                    createCredentialResponse: () => ({
                        credentialResponse: {},
                    }),
                }),
            },
            issuanceService: {
                getIssuanceConfiguration: vi.fn().mockResolvedValue({}),
            },
            resolveCredentialProofs: new ResolveCredentialProofs(),
            accessTokens: {
                verify: vi.fn().mockResolvedValue({
                    iss: "https://issuer.example",
                    sub: "session",
                    authorization_details: overrides.authorizationDetails,
                }),
            },
            subjectKeyService: {
                deriveIssuanceSetId: vi.fn().mockResolvedValue("set"),
            },
            resolveAuthorizedCredentialConfiguration:
                new ResolveAuthorizedCredentialConfiguration(),
            credentialsService: {
                getProofRequirementsForCredentialConfig: vi
                    .fn()
                    .mockResolvedValue({
                        proofTypes: ["jwt"],
                        keyAttestationsRequired:
                            overrides.keyAttestationsRequired,
                    }),
            },
            resolveCredentialSession: {
                execute:
                    overrides.resolveSession ??
                    vi.fn().mockResolvedValue({
                        session,
                        claimsResult: { claims: {} },
                        isExternalAsToken: false,
                        isChainedAsToken: false,
                    }),
            },
            auditLogger: {
                logFlowStart: vi.fn(),
                logFlowError: vi.fn(),
                logFlowComplete: vi.fn(),
                logCredentialIssuance: vi.fn(),
            },
            nonceService: { validateAndConsume: vi.fn() },
            issueCredentialsFromProofs: {
                execute:
                    overrides.issue ??
                    vi.fn().mockResolvedValue([{ credential: "credential" }]),
            },
            sessionStore: {
                updateForTenant: overrides.updateForTenant ?? vi.fn(),
            },
        });
    }

    it("issues a credential when every step succeeds", async () => {
        await expect(
            setup({}).getCredential(request, "tenant"),
        ).resolves.toEqual({ credentialResponse: {} });
    });

    it("stores the notification and marks only an active session as fetched", async () => {
        const order: string[] = [];
        const updateForTenant = vi.fn(async () => {
            order.push("notification");
        });
        const executeFrom = vi.fn(async () => {
            order.push("fetched");
            return true;
        });
        await setup({ updateForTenant, executeFrom }).getCredential(
            request,
            "tenant",
        );
        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            "session",
            {
                notifications: [
                    {
                        id: expect.any(String),
                        credentialConfigurationId: "pid",
                    },
                ],
            },
        );
        expect(executeFrom).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ id: "session", tenantId: "tenant" }),
            ["active"],
            "fetched",
        );
        expect(order).toEqual(["notification", "fetched"]);
    });

    it("passes the key attestation requirements of the credential configuration to proof verification", async () => {
        const issue = vi.fn().mockResolvedValue([{ credential: "credential" }]);
        await setup({
            issue,
            keyAttestationsRequired: { key_storage: ["iso_18045_high"] },
        }).getCredential(request, "tenant");
        expect(issue).toHaveBeenCalledWith(
            expect.objectContaining({
                keyAttestationsRequired: { key_storage: ["iso_18045_high"] },
            }),
        );
    });

    it("maps InvalidCredentialProof to invalid_proof", async () => {
        const error = await rejection(
            setup({
                issue: () =>
                    Promise.reject(
                        new InvalidCredentialProof("holder key rejected"),
                    ),
            }).getCredential(request, "tenant"),
        );
        expect(protocolError(error)).toEqual({
            error: "invalid_proof",
            error_description: "holder key rejected",
        });
    });

    it("maps CredentialAuthorizationError to its own error code", async () => {
        const error = await rejection(
            setup({
                authorizationDetails: [
                    {
                        type: "openid_credential",
                        credential_configuration_id: "other",
                    },
                ],
            }).getCredential(request, "tenant"),
        );
        const expected = new CredentialAuthorizationError(
            "invalid_credential_request",
            "Access token is not authorized for credential_configuration_id 'pid'",
        );
        expect(protocolError(error)).toEqual({
            error: expected.code,
            error_description: expected.message,
        });
    });

    it("maps CredentialSessionAuthorizationDenied to credential_request_denied", async () => {
        const error = await rejection(
            setup({
                resolveSession: () =>
                    Promise.reject(
                        new CredentialSessionAuthorizationDenied(
                            "The access token is not associated with a valid session",
                        ),
                    ),
            }).getCredential(request, "tenant"),
        );
        expect(protocolError(error)).toEqual({
            error: "credential_request_denied",
            error_description:
                "The access token is not associated with a valid session",
        });
    });

    it("maps a claim source without claims to credential_request_denied", async () => {
        const message =
            "The claim source returned no claims for credential configuration 'pid'";
        const error = await rejection(
            setup({
                resolveSession: () =>
                    Promise.reject(
                        new CredentialClaimsResolutionError(
                            "claims_missing",
                            message,
                        ),
                    ),
            }).getCredential(request, "tenant"),
        );
        expect(protocolError(error)).toEqual({
            error: "credential_request_denied",
            error_description: message,
        });

        // Other resolution errors keep their mapping.
        const providerRequired = await rejection(
            setup({
                resolveSession: () =>
                    Promise.reject(
                        new CredentialClaimsResolutionError(
                            "provider_required",
                            "provider required",
                        ),
                    ),
            }).getCredential(request, "tenant"),
        );
        expect(providerRequired).toBeInstanceOf(ConflictException);
    });

    it("propagates SessionNotFound unchanged for the controller to wrap", async () => {
        const notFound = new SessionNotFound();
        const error = await rejection(
            setup({
                resolveSession: () => Promise.reject(notFound),
            }).getCredential(request, "tenant"),
        );
        expect(error).toBe(notFound);
    });
});

describe("Oid4vciService authorization server errors", () => {
    it("maps offer errors to 409 and 400", async () => {
        const offer = (error: Error) =>
            rejection(
                service({
                    createCredentialOffer: {
                        execute: vi.fn().mockRejectedValue(error),
                    },
                }).createOffer("tenant", {} as never),
            );

        expect(await offer(new InvalidCredentialOffer())).toBeInstanceOf(
            ConflictException,
        );
        const notConfigured = await offer(
            new AuthorizationServerNotConfigured(
                "No enabled authorization server configured",
            ),
        );
        expect(notConfigured).toBeInstanceOf(BadRequestException);
        expect((notConfigured as Error).message).toBe(
            "No enabled authorization server configured",
        );
    });

    it("maps metadata resolution errors on the notification endpoint to 400", async () => {
        const error = await rejection(
            service({
                issuanceService: {
                    getIssuanceConfiguration: vi.fn().mockResolvedValue({}),
                },
                buildIssuerMetadata: {
                    execute: vi
                        .fn()
                        .mockRejectedValue(
                            new AuthorizationServerMetadataUnavailable(),
                        ),
                },
            }).handleNotification(
                {
                    method: "POST",
                    url: "/notification",
                    headers: {},
                    contentType: "application/json",
                    body: {},
                },
                { notification_id: "n", event: "credential_accepted" },
                "tenant",
            ),
        );
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toBe(
            "Failed to fetch authorization server metadata",
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
        const oid4vci = service({
            issuanceService: {
                getIssuanceConfiguration: vi.fn().mockResolvedValue({}),
            },
            accessTokens: {
                verify: vi.fn().mockResolvedValue({ sub: "session" }),
            },
            tokenSessions: {
                resolveSession: vi.fn().mockResolvedValue(session),
            },
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
        });
        const execute = () =>
            oid4vci.handleNotification(
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

describe("OID4VCI notification endpoint session resolution", () => {
    function setup(token: Record<string, unknown>) {
        const session = {
            id: "session",
            tenantId: "tenant",
            notifications: [
                { id: "notification", credentialConfigurationId: "pid" },
            ],
            authorizationServerId: "external-as",
            externalIssuer: "external",
            externalSubject: "user",
        };
        const sessions = {
            getForTenant: vi
                .fn()
                .mockImplementation(async (_tenantId: string, id?: string) => {
                    if (id !== session.id) throw new SessionNotFound();
                    return session;
                }),
        };
        const tokenSessions = new CorrelateCredentialTokenSession(
            {
                tokenIssuers: vi.fn().mockResolvedValue({
                    localIssuer: "local",
                    chainedIssuer: "chained",
                    hasChainedAuthorizationServer: true,
                    managedAuthorizationServerIssuers: new Set(["managed"]),
                }),
                externalServer: vi.fn().mockResolvedValue({
                    advertised: true,
                    configuration: {
                        id: "external-as",
                        bindingClaim: "binding",
                    },
                }),
            },
            sessions,
        );
        const changeState = vi.fn();
        const oid4vci = service({
            issuanceService: {
                getIssuanceConfiguration: vi.fn().mockResolvedValue({}),
            },
            accessTokens: { verify: vi.fn().mockResolvedValue(token) },
            tokenSessions,
            handleCredentialNotification: new HandleCredentialNotification(
                new RecordCredentialNotification({ updateForTenant: vi.fn() }),
                { findForTenant: vi.fn() },
                { publish: vi.fn() },
                { execute: changeState },
            ),
            auditLogger: { logError: vi.fn() },
        });
        const notify = (notificationId = "notification") =>
            oid4vci.handleNotification(
                {
                    method: "POST",
                    url: "/notification",
                    headers: {},
                    contentType: "application/json",
                    body: {},
                },
                {
                    notification_id: notificationId,
                    event: "credential_accepted",
                },
                "tenant",
            );
        return { notify, changeState, session };
    }

    function invalidNotificationId(error: unknown, notificationId: string) {
        expect(error).toBeInstanceOf(CredentialNotificationNotFound);
        expect((error as CredentialNotificationNotFound).notificationId).toBe(
            notificationId,
        );
    }

    it.each([
        ["local", { iss: "local", sub: "session" }],
        [
            "chained",
            { iss: "chained", sub: "upstream-user", issuer_state: "session" },
        ],
        [
            "managed (OID4VP)",
            { iss: "managed", sub: "wallet", issuer_state: "session" },
        ],
        ["external", { iss: "external", sub: "user", binding: "session" }],
    ])("completes the session of a %s token", async (_kind, token) => {
        const test = setup(token);
        await test.notify();
        expect(test.session.notifications[0]).toMatchObject({
            event: "credential_accepted",
        });
        expect(test.changeState).toHaveBeenCalledWith(
            test.session,
            "completed",
        );
    });

    it.each([
        ["of an unknown session", { iss: "local", sub: "other" }],
        ["without issuer_state", { iss: "chained", sub: "session" }],
        [
            "bound to another identity",
            { iss: "external", sub: "someone-else", binding: "session" },
        ],
        [
            "without the binding claim",
            { iss: "external", sub: "user", issuer_state: "session" },
        ],
    ])("rejects a token %s", async (_case, token) => {
        const test = setup(token);
        invalidNotificationId(await rejection(test.notify()), "notification");
        expect(test.changeState).not.toHaveBeenCalled();
    });

    it("rejects a notification_id not issued in the session", async () => {
        const test = setup({ iss: "local", sub: "session" });
        invalidNotificationId(await rejection(test.notify("other")), "other");
        expect(test.session.notifications).toEqual([
            { id: "notification", credentialConfigurationId: "pid" },
        ]);
        expect(test.changeState).not.toHaveBeenCalled();
    });
});
