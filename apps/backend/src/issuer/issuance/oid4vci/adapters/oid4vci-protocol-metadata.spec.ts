import { of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { Oid4vciProtocolMetadata } from "./oid4vci-protocol-metadata.js";

describe("Oid4vciProtocolMetadata authorization server metadata caching & deduplication", () => {
    it("caches AS metadata and deduplicates concurrent in-flight requests", async () => {
        const httpGetMock = vi.fn().mockReturnValue(
            of({
                data: {
                    issuer: "https://as.example.org",
                    token_endpoint: "https://as.example.org/token",
                },
            }),
        );
        const addCounterMock = vi.fn();
        const metricServiceMock = {
            getCounter: vi.fn(() => ({
                add: addCounterMock,
            })),
        };

        const service = Object.assign(
            Object.create(
                Oid4vciProtocolMetadata.prototype,
            ) as Oid4vciProtocolMetadata,
            {
                httpService: { get: httpGetMock },
                asMetadataCache: new Map(),
                inFlightAsMetadataRequests: new Map(),
                logger: { debug: vi.fn(), warn: vi.fn() },
                asMetadataHitsCounter: metricServiceMock.getCounter(),
                asMetadataMissesCounter: metricServiceMock.getCounter(),
                asMetadataStaleCounter: metricServiceMock.getCounter(),
                asMetadataFetchesCounter: metricServiceMock.getCounter(),
            },
        );

        const [m1, m2, m3] = await Promise.all([
            service["fetchAuthorizationServerMetadata"](
                "https://as.example.org",
            ),
            service["fetchAuthorizationServerMetadata"](
                "https://as.example.org",
            ),
            service["fetchAuthorizationServerMetadata"](
                "https://as.example.org",
            ),
        ]);

        expect(m1.issuer).toBe("https://as.example.org");
        expect(m2.issuer).toBe("https://as.example.org");
        expect(m3.issuer).toBe("https://as.example.org");
        expect(httpGetMock).toHaveBeenCalledTimes(1);

        // Next call hits cache
        const m4 = await service["fetchAuthorizationServerMetadata"](
            "https://as.example.org",
        );
        expect(m4.issuer).toBe("https://as.example.org");
        expect(httpGetMock).toHaveBeenCalledTimes(1);
    });

    it("serves stale metadata if fresh fetch fails and stale entry exists", async () => {
        const httpGetMock = vi
            .fn()
            .mockReturnValueOnce(
                of({
                    data: {
                        issuer: "https://as.example.org",
                        token_endpoint: "https://as.example.org/token",
                    },
                }),
            )
            .mockReturnValueOnce(
                throwError(() => new Error("Upstream server error")),
            );

        const service = Object.assign(
            Object.create(
                Oid4vciProtocolMetadata.prototype,
            ) as Oid4vciProtocolMetadata,
            {
                httpService: { get: httpGetMock },
                asMetadataCache: new Map(),
                inFlightAsMetadataRequests: new Map(),
                logger: { debug: vi.fn(), warn: vi.fn() },
            },
        );

        // First fetch -> populates cache
        await service["fetchAuthorizationServerMetadata"](
            "https://as.example.org",
        );

        // Force item in cache to be expired
        const cachedItem = service["asMetadataCache"].get(
            "https://as.example.org",
        );
        cachedItem.expiresAt = Date.now() - 1000;

        // Second fetch -> fresh fetch fails, fallback to stale metadata
        const stale = await service["fetchAuthorizationServerMetadata"](
            "https://as.example.org",
        );

        expect(stale.issuer).toBe("https://as.example.org");
        expect(httpGetMock).toHaveBeenCalledTimes(3);
        expect(service["logger"].warn).toHaveBeenCalledWith(
            expect.stringContaining("returning stale cached metadata"),
        );
    });
});
