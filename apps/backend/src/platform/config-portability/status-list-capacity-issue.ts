import { resourceId } from "@eudiplo/config-format/config-format.js";
import {
    isStatusListCapacity,
    STATUS_LIST_CAPACITY_MESSAGE,
} from "../../shared/domain/status-list-capacity.js";
import type {
    ConfigDocument,
    ConfigMigrationIssue,
} from "./config-resource.types.js";

/**
 * A plan error for a `StatusList` document that would create a list larger
 * than EUDIPLO can allocate. Only new lists: an existing list keeps its size,
 * also one created before the limit, so its export can be imported again.
 */
export function newStatusListCapacityIssue(
    document: ConfigDocument,
    exists: boolean,
): ConfigMigrationIssue | undefined {
    if (exists || document.kind !== "StatusList") return undefined;
    const capacity = (document.spec as { capacity?: unknown }).capacity;
    if (capacity == null || isStatusListCapacity(Number(capacity))) {
        return undefined;
    }
    return {
        severity: "error",
        code: "STATUS_LIST_CAPACITY_OUT_OF_RANGE",
        path: "/spec/capacity",
        message: STATUS_LIST_CAPACITY_MESSAGE,
        resource: { kind: "StatusList", id: resourceId(document) },
    };
}
