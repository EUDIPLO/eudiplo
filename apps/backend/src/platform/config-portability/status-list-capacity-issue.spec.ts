import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { describe, expect, it } from "vitest";
import { MAX_STATUS_LIST_CAPACITY } from "../../shared/domain/status-list-capacity.js";
import type { ConfigDocument } from "./config-resource.types.js";
import { newStatusListCapacityIssue } from "./status-list-capacity-issue.js";

const statusList = (capacity?: unknown): ConfigDocument =>
    ({
        $schema: schemaUrl("StatusList"),
        kind: "StatusList",
        metadata: { generation: 1 },
        spec: { id: "list", ...(capacity !== undefined && { capacity }) },
    }) as ConfigDocument;

describe("newStatusListCapacityIssue", () => {
    it.each([MAX_STATUS_LIST_CAPACITY + 1, Number.MAX_SAFE_INTEGER, "2000000"])(
        "blocks a new list with capacity %s",
        (capacity) => {
            expect(
                newStatusListCapacityIssue(statusList(capacity), false),
            ).toMatchObject({
                severity: "error",
                code: "STATUS_LIST_CAPACITY_OUT_OF_RANGE",
                path: "/spec/capacity",
                resource: { kind: "StatusList", id: "list" },
            });
        },
    );

    it.each([MAX_STATUS_LIST_CAPACITY, undefined])(
        "accepts a new list with capacity %s",
        (capacity) => {
            expect(
                newStatusListCapacityIssue(statusList(capacity), false),
            ).toBeUndefined();
        },
    );

    it("leaves an existing list larger than the limit to the layout check", () => {
        expect(
            newStatusListCapacityIssue(
                statusList(MAX_STATUS_LIST_CAPACITY + 1),
                true,
            ),
        ).toBeUndefined();
    });
});
