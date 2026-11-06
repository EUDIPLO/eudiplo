import { vi } from "vitest";
import type { AcceptedTrustListSequenceNumbers } from "../../src/trust/ports/accepted-trust-list-sequence-numbers.js";

/**
 * Test double of {@link AcceptedTrustListSequenceNumbers} kept in memory per
 * "tenant url", with spies on every method. Like the database adapter, it
 * only ever raises a number.
 */
export function acceptedSequenceNumbersFake(
    initial: Record<string, number> = {},
) {
    const numbers = new Map(Object.entries(initial));
    const key = (tenantId: string, url: string) => `${tenantId} ${url}`;
    return {
        numbers,
        highest: vi.fn(async (tenantId: string, url: string) =>
            numbers.get(key(tenantId, url)),
        ),
        record: vi.fn(
            async (tenantId: string, url: string, sequenceNumber: number) => {
                const current = numbers.get(key(tenantId, url));
                if (current === undefined || current < sequenceNumber) {
                    numbers.set(key(tenantId, url), sequenceNumber);
                }
            },
        ),
        forgetTenant: vi.fn(async (tenantId: string) => {
            for (const stored of [...numbers.keys()]) {
                if (stored.startsWith(`${tenantId} `)) numbers.delete(stored);
            }
        }),
    } satisfies AcceptedTrustListSequenceNumbers & {
        numbers: Map<string, number>;
    };
}
