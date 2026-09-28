import { describe, expect, it, vi } from "vitest";
import { SessionCleanupMode } from "./domain/session-retention.js";
import { SessionConfigService } from "./session-config.service.js";

describe("SessionConfigService", () => {
    it("uses typed global defaults without reading environment configuration", () => {
        const service = new SessionConfigService(
            { findOneByOrFail: vi.fn() } as never,
            {
                defaultTtlSeconds: 3600,
                defaultCleanupMode: SessionCleanupMode.Anonymize,
            },
        );

        expect(service.getDefaultTtlSeconds()).toBe(3600);
        expect(service.getDefaultCleanupMode()).toBe(
            SessionCleanupMode.Anonymize,
        );
    });
});
