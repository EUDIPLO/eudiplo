import { describe, expect, test } from "vitest";
import { MAX_STATUS_LIST_CAPACITY } from "../../../shared/domain/status-list-capacity.js";
import {
    CreateStatusListSchema,
    UpdateStatusListConfigSchema,
} from "./status-list.schema.js";

const schemas = {
    CreateStatusListSchema: (capacity: number) =>
        CreateStatusListSchema.safeParse({ capacity }),
    UpdateStatusListConfigSchema: (capacity: number) =>
        UpdateStatusListConfigSchema.safeParse({ capacity }),
};

describe.each(Object.entries(schemas))("%s capacity", (_, parse) => {
    test("accepts the limit", () => {
        expect(parse(MAX_STATUS_LIST_CAPACITY).success).toBe(true);
    });

    test.each([MAX_STATUS_LIST_CAPACITY + 1, Number.MAX_SAFE_INTEGER])(
        "refuses %s",
        (capacity) => {
            const result = parse(capacity);
            expect(result.success).toBe(false);
            expect(result.error?.issues[0]?.path).toEqual(["capacity"]);
        },
    );
});
