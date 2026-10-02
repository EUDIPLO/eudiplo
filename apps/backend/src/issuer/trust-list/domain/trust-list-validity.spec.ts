import { describe, expect, it } from "vitest";
import {
    isTrustListRenewalDue,
    TRUST_LIST_RENEWAL_WINDOW_MS,
    TRUST_LIST_VALIDITY_MS,
    trustListNextUpdate,
} from "./trust-list-validity.js";

describe("trust list validity", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const inMs = (ms: number) => new Date(now.getTime() + ms).toISOString();

    it("issues lists for 30 days and renews them in the last third", () => {
        expect(trustListNextUpdate(now).toISOString()).toBe(
            "2026-11-01T12:00:00.000Z",
        );
        expect(TRUST_LIST_RENEWAL_WINDOW_MS).toBe(TRUST_LIST_VALIDITY_MS / 3);
    });

    it("is due inside the renewal window and after NextUpdate", () => {
        expect(
            isTrustListRenewalDue(inMs(TRUST_LIST_RENEWAL_WINDOW_MS + 1), now),
        ).toBe(false);
        expect(
            isTrustListRenewalDue(inMs(TRUST_LIST_RENEWAL_WINDOW_MS), now),
        ).toBe(true);
        expect(isTrustListRenewalDue("2026-02-01T09:40:29.793Z", now)).toBe(
            true,
        );
    });

    it("is due when NextUpdate is missing or unreadable", () => {
        expect(isTrustListRenewalDue(undefined, now)).toBe(true);
        expect(isTrustListRenewalDue("soon", now)).toBe(true);
    });
});
