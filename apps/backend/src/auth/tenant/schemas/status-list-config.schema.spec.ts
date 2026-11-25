import { describe, expect, test } from "vitest";
import { MAX_STATUS_LIST_CAPACITY } from "../../../shared/domain/status-list-capacity.js";
import { StatusListConfigSchema } from "./status-list-config.schema.js";

describe("StatusListConfigSchema capacity", () => {
    test("accepts the limit", () => {
        expect(
            StatusListConfigSchema.safeParse({
                capacity: MAX_STATUS_LIST_CAPACITY,
            }).success,
        ).toBe(true);
    });

    test.each([MAX_STATUS_LIST_CAPACITY + 1, Number.MAX_SAFE_INTEGER])(
        "refuses %s",
        (capacity) => {
            const result = StatusListConfigSchema.safeParse({ capacity });
            expect(result.success).toBe(false);
            expect(result.error?.issues[0]?.path).toEqual(["capacity"]);
        },
    );
});
