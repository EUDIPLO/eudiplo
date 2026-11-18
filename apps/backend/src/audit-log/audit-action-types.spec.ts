import { describe, expect, it } from "vitest";
import {
    AUDIT_ACTION_TYPES,
    AUDIT_OBJECT_TYPES,
    actionTypesMatching,
    actionTypesOf,
} from "./audit-action-types.js";

describe("audit action catalog", () => {
    it("names every action as its object followed by one verb", () => {
        // The web client derives the object from the action type this way.
        for (const objectType of AUDIT_OBJECT_TYPES) {
            for (const action of actionTypesOf(objectType)) {
                expect(action.startsWith(`${objectType}_`), action).toBe(true);
                expect(
                    action.slice(objectType.length + 1),
                    action,
                ).not.toContain("_");
            }
        }
        expect(
            AUDIT_OBJECT_TYPES.flatMap((objectType) =>
                actionTypesOf(objectType),
            ),
        ).toHaveLength(AUDIT_ACTION_TYPES.length);
    });

    it("finds actions as written and as the web client labels them", () => {
        expect(actionTypesMatching("OpenID Connect Client Created")).toEqual([
            "oidc_client_created",
        ]);
        expect(actionTypesMatching("bundle_exported")).toEqual([
            "config_bundle_exported",
        ]);
        expect(actionTypesMatching("  ")).toEqual([]);
    });
});
