import { describe, expect, it } from "vitest";
import {
    usesRemovedChainedVp,
    withoutRemovedChainedVp,
} from "./removed-authorization-servers.js";

const upstream = { issuer: "https://idp.example", clientId: "eudiplo" };
const vp = { enabled: true, presentationConfigId: "pid" };

describe("removed chained 'vp' authorization servers", () => {
    it("detects chained entries with 'vp' only", () => {
        expect(usesRemovedChainedVp({ type: "chained", id: "c", vp })).toBe(
            true,
        );
        expect(
            usesRemovedChainedVp({ type: "chained", id: "c", upstream }),
        ).toBe(false);
        expect(usesRemovedChainedVp({ type: "oid4vp", id: "o", vp })).toBe(
            false,
        );
        expect(usesRemovedChainedVp(undefined)).toBe(false);
    });

    it("skips stored entries without upstream and strips 'vp' otherwise", () => {
        const builtIn = { type: "built-in", id: "built-in" };

        expect(
            withoutRemovedChainedVp([
                builtIn,
                { type: "chained", id: "legacy-vp", vp },
                { type: "chained", id: "chained", upstream, vp },
            ]),
        ).toEqual({
            servers: [builtIn, { type: "chained", id: "chained", upstream }],
            changedIds: ["legacy-vp", "chained"],
        });
        expect(withoutRemovedChainedVp([builtIn])).toEqual({
            servers: [builtIn],
            changedIds: [],
        });
    });
});
