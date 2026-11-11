import { ES256 } from "@owf/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevocationListUnavailableError } from "../../../../trust/revocation-policy.util.js";
import { SdjwtvcverifierService } from "./sdjwtvcverifier.service.js";

const instanceConfigs: any[] = [];
const verifyMock = vi.fn();

vi.mock("@sd-jwt/sd-jwt-vc", () => ({
    SDJwtVcInstance: class {
        private readonly cfg: any;

        constructor(cfg: any) {
            this.cfg = cfg;
            instanceConfigs.push(cfg);
        }

        verify(cred: string, options: any) {
            return verifyMock(cred, options, this.cfg);
        }
    },
}));

describe("SdjwtvcverifierService revocation mode", () => {
    let service: SdjwtvcverifierService;
    let statusListVerifier: { getStatusListJwt: ReturnType<typeof vi.fn> };
    const logger = {
        setContext: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    };
    const statusList = { uri: "https://issuer.example/status/1", idx: 3 };

    beforeEach(() => {
        verifyMock.mockReset();
        instanceConfigs.length = 0;
        vi.clearAllMocks();

        const resolverService = {};
        const cryptoService = {};
        statusListVerifier = {
            getStatusListJwt: vi.fn(),
        };

        service = new SdjwtvcverifierService(
            resolverService as any,
            cryptoService as any,
            {} as any, // chainValidation — no list is fetched successfully here
            statusListVerifier as any,
            {} as any, // federationTrust — unused without a federation trust source
            logger as any,
        );
    });

    const verifyInMode = (enabled: boolean, failClosed: boolean) =>
        service.verify("credential", {
            policy: {
                requireX5c: true,
                revocation: { enabled, failClosed },
            },
        } as any);

    it("never lets the library check the status", async () => {
        verifyMock.mockResolvedValue({ payload: { sub: "abc" } });

        await verifyInMode(true, true);

        expect(verifyMock.mock.calls[0][1]).toMatchObject({
            disableStatusVerification: true,
        });
        expect(instanceConfigs[0].statusListFetcher).toBeUndefined();
        expect(instanceConfigs[0].statusVerifier).toBeUndefined();
    });

    it("accepts the credential in best-effort mode when the status list is unavailable", async () => {
        const payload = { sub: "abc", status: { status_list: statusList } };
        verifyMock.mockResolvedValue({ payload });
        statusListVerifier.getStatusListJwt.mockRejectedValue(
            new RevocationListUnavailableError(
                "Failed to fetch status list: timed out",
            ),
        );

        const result = await verifyInMode(true, false);

        expect(result.payload).toEqual(payload);
        expect(verifyMock).toHaveBeenCalledOnce();
        expect(statusListVerifier.getStatusListJwt).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("rejects it in best-effort mode for any other status list error", async () => {
        // The message reads like an unavailable list, the error class does not.
        verifyMock.mockResolvedValue({
            payload: { status: { status_list: statusList } },
        });
        statusListVerifier.getStatusListJwt.mockRejectedValue(
            new TypeError("Status list at network-timeout returned CWT"),
        );

        await expect(verifyInMode(true, false)).rejects.toThrow("returned CWT");
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("fails closed in strict mode when status list is unavailable", async () => {
        verifyMock.mockResolvedValue({
            payload: { status: { status_list: statusList } },
        });
        statusListVerifier.getStatusListJwt.mockRejectedValue(
            new RevocationListUnavailableError("Status list unavailable"),
        );

        await expect(verifyInMode(true, true)).rejects.toThrow(
            "Status list unavailable",
        );

        expect(verifyMock).toHaveBeenCalledOnce();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("skips the status check entirely when revocation is disabled", async () => {
        const payload = { ok: true, status: { status_list: statusList } };
        verifyMock.mockResolvedValue({ payload });

        const result = await verifyInMode(false, false);

        expect(result.payload).toEqual(payload);
        expect(verifyMock).toHaveBeenCalledOnce();
        expect(statusListVerifier.getStatusListJwt).not.toHaveBeenCalled();
    });

    describe("status claim without a status list", () => {
        const verifyWith = (failClosed: boolean, enabled = true) =>
            service.verify("credential", {
                policy: {
                    requireX5c: true,
                    revocation: { enabled, failClosed },
                },
            } as any);

        it("accepts a credential without a status claim in strict mode", async () => {
            verifyMock.mockResolvedValue({ payload: { sub: "abc" } });

            await expect(verifyWith(true)).resolves.toEqual({
                payload: { sub: "abc" },
            });
        });

        it("rejects it in strict mode", async () => {
            // The shape the test helpers produced by nesting createEntry's
            // result under `status`.
            verifyMock.mockResolvedValue({
                payload: {
                    status: { status: { status_list: { idx: 0, uri: "x" } } },
                },
            });

            await expect(verifyWith(true)).rejects.toMatchObject({
                failureType: "verification_error",
                verboseReason: expect.stringContaining(
                    "no supported status mechanism",
                ),
            });
        });

        it("accepts it with a warning in best-effort mode", async () => {
            const payload = { status: { unknown_mechanism: {} } };
            verifyMock.mockResolvedValue({ payload });

            await expect(verifyWith(false)).resolves.toEqual({ payload });
            expect(logger.warn).toHaveBeenCalledOnce();
        });

        it("accepts it when revocation is disabled", async () => {
            const payload = { status: { unknown_mechanism: {} } };
            verifyMock.mockResolvedValue({ payload });

            await expect(verifyWith(false, false)).resolves.toEqual({
                payload,
            });
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });
});

describe("SdjwtvcverifierService status list signature", () => {
    const b64url = (input: string | ArrayBuffer) =>
        Buffer.from(
            typeof input === "string" ? input : new Uint8Array(input),
        ).toString("base64url");

    async function signedStatusList() {
        const keys = (await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        )) as CryptoKeyPair;
        const header = b64url(JSON.stringify({ alg: "ES256", x5c: ["leaf"] }));
        const data = `${header}.${b64url(JSON.stringify({ status_list: { bits: 1, lst: "AA" } }))}`;
        const signature = b64url(
            await crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" },
                keys.privateKey,
                new TextEncoder().encode(data),
            ),
        );
        const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
        return { header, data, signature, publicKey };
    }

    const throwingCrypto = {
        getVerifier: async () => async () => {
            throw new Error("unsupported key");
        },
    };

    function createService(publicKey: JsonWebKey, cryptoImpl: unknown = ES256) {
        const chainValidation = {
            verifyStatusListSignature: vi.fn().mockResolvedValue(true),
        };
        const service = new SdjwtvcverifierService(
            { resolvePublicKey: vi.fn().mockResolvedValue(publicKey) } as any,
            { getCryptoFromJwk: () => cryptoImpl } as any,
            chainValidation as any,
            {} as any,
            {} as any,
            { setContext: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
        );
        const verifyStatusList = (data: string, signature: string) =>
            (service as any).verifyStatusList(
                data,
                signature,
                { policy: {} },
                null,
            ) as Promise<boolean>;
        return { verifyStatusList, chainValidation };
    }

    it("accepts a correctly signed status list with a trusted chain", async () => {
        const { data, signature, publicKey } = await signedStatusList();
        const { verifyStatusList, chainValidation } = createService(publicKey);

        await expect(verifyStatusList(data, signature)).resolves.toBe(true);
        expect(
            chainValidation.verifyStatusListSignature,
        ).toHaveBeenCalledOnce();
    });

    it("rejects a forged payload even when the chain is trusted", async () => {
        const { header, signature, publicKey } = await signedStatusList();
        const { verifyStatusList, chainValidation } = createService(publicKey);
        const forged = `${header}.${b64url(JSON.stringify({ status_list: { bits: 1, lst: "AQ" } }))}`;

        await expect(verifyStatusList(forged, signature)).resolves.toBe(false);
        expect(
            chainValidation.verifyStatusListSignature,
        ).not.toHaveBeenCalled();
    });

    it("rejects the status list when the signature cannot be checked", async () => {
        const { data, signature, publicKey } = await signedStatusList();
        const { verifyStatusList, chainValidation } = createService(
            publicKey,
            throwingCrypto,
        );

        await expect(verifyStatusList(data, signature)).resolves.toBe(false);
        expect(
            chainValidation.verifyStatusListSignature,
        ).not.toHaveBeenCalled();
    });
});
