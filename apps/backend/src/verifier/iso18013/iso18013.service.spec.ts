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
            {} as any, // configService
            {} as any, // certService
            {} as any, // keyChainService
            webhookEndpointRepo as any,
            {} as any, // logger
            {} as any, // trustedAuthoritiesService
            {} as any, // changeSessionState
        );
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

    it("falls back to the configured webhook when no override is given", async () => {
        await service.createOffer("req", "tenant", "https://origin.example");

        expect(sessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({ parsedWebhook: CONFIG_WEBHOOK }),
        );
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

        service = new Iso18013Service(
            {
                getPresentationConfig: vi.fn().mockResolvedValue({
                    dcql_query: {
                        credentials: [
                            { id: "mdl", format: "mso_mdoc", claims: [] },
                        ],
                    },
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
            { getOrThrow: () => "https://eudiplo.example" } as any,
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
            .processResponse("session", "encrypted")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        const message = "The credential issuer is not in the trusted list.";
        const outcome = {
            result: "failed",
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

    it("reports an undecryptable response as failed", async () => {
        vi.mocked(hpkeOpen).mockImplementation(() => {
            throw new Error("bad tag");
        });

        const error = await service
            .processResponse("session", "encrypted")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome: { result: "failed", message: "HPKE decryption failed" },
        });
    });

    it("keeps the failure response when the webhook cannot be delivered", async () => {
        verify.mockResolvedValue({
            verified: false,
            failure: { type: "signature_invalid", message: "failed" },
        });
        publish.mockRejectedValue(new Error("webhook down"));

        const error = await service
            .processResponse("session", "encrypted")
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
        });

        await expect(
            service.processResponse("session", "encrypted"),
        ).resolves.toEqual({});

        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "completed",
            outcome: {
                result: "success",
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
