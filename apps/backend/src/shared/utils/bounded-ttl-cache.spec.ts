import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedTtlCache } from "./bounded-ttl-cache.js";

describe("BoundedTtlCache", () => {
    const now = new Date("2026-10-05T12:00:00Z").getTime();
    const later = now + 60_000;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(now);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const cache = (maxEntries = 3, maxBytes = 100) =>
        new BoundedTtlCache<string>({ maxEntries, maxBytes });

    it("returns a value until it expires", () => {
        const values = cache();
        values.set("a", "A", 1, later);

        expect(values.get("a")).toBe("A");
        vi.setSystemTime(later - 1);
        expect(values.get("a")).toBe("A");
        vi.setSystemTime(later);
        expect(values.get("a")).toBeUndefined();
        expect(values.size).toBe(0);
    });

    it("evicts the least recently used entry beyond the entry limit", () => {
        const values = cache(3);
        values.set("a", "A", 1, later);
        values.set("b", "B", 1, later);
        values.set("c", "C", 1, later);
        values.get("a");

        values.set("d", "D", 1, later);

        expect([...values.keys()]).toEqual(["c", "a", "d"]);
        expect(values.get("b")).toBeUndefined();
    });

    it("evicts least recently used entries beyond the byte budget", () => {
        const values = cache(10, 100);
        values.set("a", "A", 40, later);
        values.set("b", "B", 40, later);
        values.set("c", "C", 10, later);

        values.set("d", "D", 60, later);

        expect([...values.keys()]).toEqual(["c", "d"]);
        expect(values.bytes).toBe(70);
    });

    it("drops expired entries on insert", () => {
        const values = cache();
        values.set("a", "A", 10, now + 1000);
        values.set("b", "B", 10, later);

        vi.setSystemTime(now + 1000);
        values.set("c", "C", 10, later);

        expect([...values.keys()]).toEqual(["b", "c"]);
        expect(values.bytes).toBe(20);
    });

    it("does not cache an entry larger than the byte budget", () => {
        const values = cache(3, 100);
        values.set("a", "A", 10, later);

        expect(values.set("b", "B", 101, later)).toBe(false);
        expect([...values.keys()]).toEqual(["a"]);
    });

    it("does not cache an entry that has already expired", () => {
        const values = cache();

        expect(values.set("a", "A", 1, now)).toBe(false);
        expect(values.size).toBe(0);
    });

    it("replaces an entry and its size", () => {
        const values = cache(3, 100);
        values.set("a", "A", 60, later);
        values.set("b", "B", 30, later);

        values.set("a", "A2", 70, later);

        expect(values.get("a")).toBe("A2");
        expect(values.get("b")).toBe("B");
        expect(values.bytes).toBe(100);
    });

    it("drops all expired entries and clears", () => {
        const values = cache();
        values.set("a", "A", 10, now + 1000);
        values.set("b", "B", 10, later);

        vi.setSystemTime(now + 1000);
        values.deleteExpired();
        expect([...values.keys()]).toEqual(["b"]);

        values.clear();
        expect(values.size).toBe(0);
        expect(values.bytes).toBe(0);
    });
});
