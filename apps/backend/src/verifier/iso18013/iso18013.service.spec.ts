import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate createOffer's config→session logic from the real CBOR/crypto builders.
vi.mock("./cbor-request", () => ({
    buildEncryptionInfo: vi.fn(() => Buffer.from("ei")),
    buildItemsRequest: vi.fn(() => ({})),
    buildDeviceRequestCbor: vi.fn(() => Buffer.from("dr")),
    buildIsoMdocDcApiTranscript: vi.fn(),
    parseEncryptedResponse: vi.fn(),
    buildReaderAuth: vi.fn(),
}));
vi.mock("./hpke", () => ({ hpkeOpen: vi.fn() }));

import {
    buildIsoMdocDcApiTranscript,
    parseEncryptedResponse,
} from "./cbor-request.js";
import { hpkeOpen } from "./hpke.js";
import { Iso18013Service } from "./iso18013.service.js";

const CONFIG_WEBHOOK = { url: "https://config.example/hook" } as any;
const OVERRIDE_WEBHOOK = {
    url: "https://override.example/hook",
    auth: {
        type: "apiKey",
        config: { headerName: "X-Callback-Secret", value: "s3cret" },
    },
} as any;

describe("Iso18013Service.createOffer per-request webhook override", () => {
    let sessionCreate: ReturnType<typeof vi.fn>;
    let service: Iso18013Service;

    beforeEach(() => {
        sessionCreate = vi.fn().mockResolvedValue(undefined);
        const presentationConfigService = {
            getPresentationConfig: vi.fn().mockResolvedValue({
                dcql_query: {
                    credentials: [
                        {
                            format: "mso_mdoc",
                            meta: { doctype_value: "eu.europa.ec.av.1" },
                            claims: [],
                        },
                    ],
                },
                webhookEndpointId: "endpoint-1",
                readerAuth: false,
                lifeTime: 300,
                allowedOrigins: ["https://origin.example"],
            }),
        };
        const encryptionService = {
            getEncryptionPublicKey: vi
                .fn()
                .mockResolvedValue({ x: "x", y: "y" }),
        };
        const createSession = { execute: sessionCreate };
        const sessionStore = { updateForTenant: vi.fn() };
        const webhookEndpointRepo = {
            findOneBy: vi.fn().mockResolvedValue({
                url: "https://config.example/hook",
            }),
        };

        service = new Iso18013Service(
            presentationConfigService as any,
            createSession as any,
            sessionStore as any,
            encryptionService as any,
            {} as any, // credentialVerifierFormats
            {} as any, // webhookService
            {} as any, // auditLogService
            { getOrThrow: () => "https://eudiplo.example" } as any,
            {} as any, // certService
            {} as any, // keyChainService
            webhookEndpointRepo as any,
            {} as any, // logger
            {} as any, // trustedAuthoritiesService
            {} as any, // changeSessionState
        );
    });

    describe("transaction data", () => {
        const entry = {
            type: "urn:eudi:sca:account_access:1",
            credential_ids: ["mdl"],
            payload: { transaction_id: "t-1" },
        };
        const withConfiguredEntry = () =>
            (
                service as unknown as {
                    presentationConfigService: {
                        getPresentationConfig: ReturnType<typeof vi.fn>;
                    };
                }
            ).presentationConfigService.getPresentationConfig.mockResolvedValue(
                {
                    dcql_query: {
                        credentials: [
                            {
                                format: "mso_mdoc",
                                meta: { doctype_value: "eu.europa.ec.av.1" },
                                claims: [],
                            },
                        ],
                    },
                    transaction_data: [entry],
                    allowedOrigins: ["https://origin.example"],
                },
            );

        it("refuses request transaction data, which the request cannot carry", async () => {
            const error = await service
                .createOffer(
                    "req",
                    "tenant",
                    "https://origin.example",
                    undefined,
                    undefined,
                    undefined,
                    [entry],
                )
                .catch((error) => error);

            expect(error.getStatus()).toBe(400);
            expect(error.message).toContain(
                "ISO 18013-7 requests cannot carry transaction data",
            );
            expect(sessionCreate).not.toHaveBeenCalled();
        });

        it("refuses a configuration with transaction data", async () => {
            withConfiguredEntry();

            await expect(
                service.createOffer("req", "tenant", "https://origin.example"),
            ).rejects.toThrow(
                "ISO 18013-7 requests cannot carry transaction data",
            );
            expect(sessionCreate).not.toHaveBeenCalled();
        });

        it("accepts such a configuration when the request sends an empty list", async () => {
            withConfiguredEntry();

            await service.createOffer(
                "req",
                "tenant",
                "https://origin.example",
                undefined,
                undefined,
                undefined,
                [],
            );

            expect(sessionCreate).toHaveBeenCalled();
        });
    });

    it("persists the per-request webhook override on the session", async () => {
        await service.createOffer(
            "req",
            "tenant",
            "https://origin.example",
            undefined,
            OVERRIDE_WEBHOOK,
        );

        expect(sessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({ parsedWebhook: OVERRIDE_WEBHOOK }),
        );
    });

    it("names the session to the page with a random wallet nonce, not its ID", async () => {
        const offer = await service.createOffer(
            "req",
            "tenant",
            "https://origin.example",
        );

        const { id, walletNonce } = sessionCreate.mock.calls[0][0];
        expect(offer.session).toBe(id);
        expect(walletNonce).toEqual(expect.any(String));
        expect(walletNonce).not.toBe(id);
        expect(offer.org_iso_mdoc.response_uri).toBe(
            `https://eudiplo.example/presentations/${walletNonce}/iso-18013-7`,
        );
    });

    it("falls back to the configured webhook when no override is given", async () => {
        await service.createOffer("req", "tenant", "https://origin.example");

        expect(sessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({ parsedWebhook: CONFIG_WEBHOOK }),
        );
    });

    it("binds the session transcript to the allowed origin", async () => {
        await service.createOffer(
            "req",
            "tenant",
            "https://origin.example/checkout",
        );

        expect(sessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                browserOrigin: "https://origin.example",
            }),
        );
    });

    it("uses the only allowed origin when none is requested", async () => {
        await service.createOffer("req", "tenant", undefined);

        expect(sessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                browserOrigin: "https://origin.example",
            }),
        );
    });

    it("needs an origin when the configuration lists none", async () => {
        (
            service as unknown as {
                presentationConfigService: {
                    getPresentationConfig: ReturnType<typeof vi.fn>;
                };
            }
        ).presentationConfigService.getPresentationConfig.mockResolvedValueOnce(
            {
                dcql_query: { credentials: [] },
                allowedOrigins: null,
            },
        );

        await expect(
            service.createOffer("req", "tenant", undefined),
        ).rejects.toThrow('Presentation config "req" needs expected_origin');
        expect(sessionCreate).not.toHaveBeenCalled();
    });

    it("refuses an origin the configuration does not allow", async () => {
        await expect(
            service.createOffer("req", "tenant", "https://evil.example"),
        ).rejects.toThrow(
            'Presentation config "req" does not allow the origin https://evil.example',
        );
        expect(sessionCreate).not.toHaveBeenCalled();
    });
});

describe("Iso18013Service.processResponse presentation webhook", () => {
    const webhook = {
        url: "https://webhook.example/result",
        auth: { type: "none" },
    } as any;
    let session: Record<string, unknown>;
    let sessionStore: Record<string, ReturnType<typeof vi.fn>>;
    let announce: ReturnType<typeof vi.fn>;
    let publish: ReturnType<typeof vi.fn>;
    let verify: ReturnType<typeof vi.fn>;
    let mdlQuery: Record<string, unknown>;
    let service: Iso18013Service;

    beforeEach(() => {
        vi.mocked(buildIsoMdocDcApiTranscript).mockResolvedValue({
            sessionTranscript: {},
            hpkeInfo: Buffer.from("info"),
        } as any);
        vi.mocked(parseEncryptedResponse).mockReturnValue({
            enc: Buffer.from("enc"),
            cipherText: Buffer.from("ct"),
        } as any);
        vi.mocked(hpkeOpen).mockReturnValue(Buffer.from("device-response"));

        session = {
            id: "session",
            tenantId: "tenant",
            requestId: "req",
            consumed: false,
            vp_nonce: "00",
            browserOrigin: "https://origin.example",
            parsedWebhook: webhook,
            transaction_data: undefined,
        };
        sessionStore = {
            getIso18013: vi.fn().mockResolvedValue(session),
            updateForTenant: vi.fn().mockResolvedValue(1),
            updateIfUnconsumed: vi.fn().mockResolvedValue(true),
        };
        announce = vi.fn();
        publish = vi.fn().mockResolvedValue({});
        verify = vi.fn();
        mdlQuery = {
            id: "mdl",
            format: "mso_mdoc",
            claims: [],
            trusted_authorities: [
                { type: "etsi_tl", values: [{ trustListId: "mdl-issuers" }] },
            ],
        };

        service = new Iso18013Service(
            {
                getPresentationConfig: vi.fn().mockResolvedValue({
                    dcql_query: { credentials: [mdlQuery] },
                }),
            } as any,
            {} as any, // createSession
            sessionStore as any,
            {
                getEncryptionPrivateJwk: vi
                    .fn()
                    .mockResolvedValue({ x: "x", y: "y", d: "d" }),
            } as any,
            { resolve: () => ({ verify }) } as any,
            { publish } as any,
            {
                logFlowStart: vi.fn(),
                logFlowError: vi.fn(),
                logFlowComplete: vi.fn(),
                logCredentialVerification: vi.fn(),
            } as any,
            {
                getOrThrow: () => "https://eudiplo.example",
                get: () => undefined,
            } as any,
            {} as any, // certService
            {} as any, // keyChainService
            { findOneBy: vi.fn() } as any,
            { warn: vi.fn() } as any,
            {
                resolveTrustListRefsForTenant: vi.fn().mockResolvedValue([]),
            } as any,
            { announce } as any,
        );
    });

    it("verifies against the trust lists of the session's tenant", async () => {
        verify.mockResolvedValue({
            verified: false,
            docType: "org.iso.18013.5.1.mDL",
            failure: {
                type: "trust_chain_not_trusted",
                reason: "verbose",
                message: "failed",
            },
        });

        await service
            .processResponse("wallet-nonce", "encrypted")
            .catch(() => undefined);

        expect(verify).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                options: expect.objectContaining({
                    trustListSource: expect.objectContaining({
                        tenantId: "tenant",
                    }),
                }),
            }),
        );
    });

    it("reports a failed mDOC verification with status, outcome and no credentials", async () => {
        verify.mockResolvedValue({
            verified: false,
            docType: "org.iso.18013.5.1.mDL",
            failure: {
                type: "trust_chain_not_trusted",
                reason: "verbose",
                message: "failed",
            },
        });

        const error = await service
            .processResponse("wallet-nonce", "encrypted")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        const message = "The credential issuer is not in the trusted list.";
        const outcome = {
            result: "failed",
            source: "verifier",
            error: "trust_chain_not_trusted",
            message,
            credentials: [
                {
                    id: "mdl",
                    format: "mso_mdoc",
                    docType: "org.iso.18013.5.1.mDL",
                    verified: false,
                    error: "trust_chain_not_trusted",
                    message,
                },
            ],
        };
        expect(sessionStore.updateIfUnconsumed).toHaveBeenCalledWith(
            "tenant",
            "session",
            expect.objectContaining({
                status: "failed",
                failureCode: "trust_chain_not_trusted",
                outcome,
            }),
        );
        expect(announce).toHaveBeenCalledWith(session, "failed");
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome,
        });
    });

    it("rejects an mso_mdoc query without trusted_authorities before verifying", async () => {
        delete mdlQuery.trusted_authorities;

        const error = await service
            .processResponse("wallet-nonce", "encrypted")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toContain(
            "Credential queries without trusted_authorities: mdl.",
        );
        expect(verify).not.toHaveBeenCalled();
    });

    it("reports an undecryptable response as failed", async () => {
        vi.mocked(hpkeOpen).mockImplementation(() => {
            throw new Error("bad tag");
        });

        const error = await service
            .processResponse("wallet-nonce", "encrypted")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        // The exception text stays in the log, out of the stored session.
        expect(sessionStore.updateIfUnconsumed).toHaveBeenCalledWith(
            "tenant",
            "session",
            expect.objectContaining({ errorReason: "HPKE decryption failed" }),
        );
        expect(
            JSON.stringify(
                vi.mocked(sessionStore.updateIfUnconsumed).mock.calls,
            ),
        ).not.toContain("bad tag");
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome: {
                result: "failed",
                source: "verifier",
                message: "HPKE decryption failed",
            },
        });
    });

    it("keeps the failure response when the webhook cannot be delivered", async () => {
        verify.mockResolvedValue({
            verified: false,
            failure: { type: "signature_invalid", message: "failed" },
        });
        publish.mockRejectedValue(new Error("webhook down"));

        const error = await service
            .processResponse("wallet-nonce", "encrypted")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toEqual({
            error: "signature_invalid",
            message: "The credential signature is invalid.",
        });
        expect(sessionStore.updateIfUnconsumed).toHaveBeenCalledOnce();
    });

    it("reports a completed presentation with status, outcome and credentials", async () => {
        verify.mockResolvedValue({
            verified: true,
            docType: "org.iso.18013.5.1.mDL",
            claims: { family_name: "Mustermann" },
            missingClaims: [],
            mismatchedClaims: [],
        });

        await expect(
            service.processResponse("wallet-nonce", "encrypted"),
        ).resolves.toEqual({});

        expect(sessionStore.getIso18013).toHaveBeenCalledExactlyOnceWith(
            "wallet-nonce",
        );
        // The session is changed by its ID, never by the wallet nonce.
        expect(sessionStore.updateIfUnconsumed).toHaveBeenCalledWith(
            "tenant",
            "session",
            expect.objectContaining({ status: "completed" }),
        );
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "completed",
            outcome: {
                result: "success",
                source: "verifier",
                credentials: [
                    {
                        id: "mdl",
                        format: "mso_mdoc",
                        docType: "org.iso.18013.5.1.mDL",
                        verified: true,
                        trust: undefined,
                    },
                ],
            },
            credentials: [
                {
                    id: "mdl",
                    format: "mso_mdoc",
                    docType: "org.iso.18013.5.1.mDL",
                    claims: { family_name: "Mustermann" },
                },
            ],
        });
        expect(sessionStore.updateForTenant).not.toHaveBeenCalled();
    });
});
