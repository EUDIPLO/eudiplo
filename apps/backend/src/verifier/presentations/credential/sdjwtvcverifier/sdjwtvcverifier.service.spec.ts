import { beforeEach, describe, expect, it, vi } from "vitest";
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
    const logger = {
        setContext: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    };

    beforeEach(() => {
        verifyMock.mockReset();
        instanceConfigs.length = 0;
        vi.clearAllMocks();

        const resolverService = {};
        const cryptoService = {};
        const chainValidation = {
            fetchStatusListJwt: vi.fn(),
        };

        service = new SdjwtvcverifierService(
            resolverService as any,
            cryptoService as any,
            chainValidation as any,
            logger as any,
        );
    });

    it("retries without status check in best-effort mode when status list is unavailable", async () => {
        verifyMock.mockImplementation(
            async (_cred: string, _options: any, cfg: any) => {
                if (cfg.statusListFetcher) {
                    throw new Error(
                        "Status list fetch timed out after 10000ms",
                    );
                }
                return {
                    payload: { sub: "abc" },
                };
            },
        );

        const result = await service.verify("credential", {
            policy: {
                requireX5c: true,
                revocation: {
                    enabled: true,
                    failClosed: false,
                },
            },
        } as any);

        expect(result.payload).toEqual({ sub: "abc" });
        expect(verifyMock).toHaveBeenCalledTimes(2);
        expect(instanceConfigs[0].statusListFetcher).toBeTypeOf("function");
        expect(instanceConfigs[1].statusListFetcher).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("fails closed in strict mode when status list is unavailable", async () => {
        verifyMock.mockImplementation(async () => {
            throw new Error("Status list unavailable");
        });

        await expect(
            service.verify("credential", {
                policy: {
                    requireX5c: true,
                    revocation: {
                        enabled: true,
                        failClosed: true,
                    },
                },
            } as any),
        ).rejects.toThrow("Status list unavailable");

        expect(verifyMock).toHaveBeenCalledTimes(1);
        expect(instanceConfigs[0].statusListFetcher).toBeTypeOf("function");
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("skips status callbacks entirely when revocation is disabled", async () => {
        verifyMock.mockResolvedValue({ payload: { ok: true } });

        const result = await service.verify("credential", {
            policy: {
                requireX5c: true,
                revocation: {
                    enabled: false,
                    failClosed: false,
                },
            },
        } as any);

        expect(result.payload).toEqual({ ok: true });
        expect(verifyMock).toHaveBeenCalledTimes(1);
        expect(instanceConfigs[0].statusListFetcher).toBeUndefined();
        expect(instanceConfigs[0].statusVerifier).toBeUndefined();
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

            await expect(verifyWith(true)).rejects.toThrow(
                "no supported status mechanism",
            );
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
