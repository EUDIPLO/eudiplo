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
