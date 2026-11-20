import { describe, expect, it } from "vitest";
import {
    hasConfigLimits,
    typeOfSession,
    withinConfigLimits,
} from "./session-list.js";

describe("typeOfSession", () => {
    it("tells presentation sessions by their presentation configuration", () => {
        expect(typeOfSession({ requestId: "age-check" })).toBe("presentation");
        expect(typeOfSession({ requestId: null })).toBe("issuance");
        expect(typeOfSession({})).toBe("issuance");
        // Like the store's `requestId IS NULL`, an empty ID is a presentation.
        expect(typeOfSession({ requestId: "" })).toBe("presentation");
    });
});

describe("withinConfigLimits", () => {
    const limits = { presentation: ["pid"], issuance: ["membership", "pid"] };

    it("keeps a presentation session of an allowed configuration only", () => {
        expect(withinConfigLimits({ requestId: "pid" }, limits)).toBe(true);
        expect(withinConfigLimits({ requestId: "mdl" }, limits)).toBe(false);
    });

    it("keeps an issuance session only when every offered configuration is allowed", () => {
        const offers = (...credentialConfigurationIds: string[]) =>
            withinConfigLimits({ credentialConfigurationIds }, limits);
        expect(offers("pid")).toBe(true);
        expect(offers("pid", "membership")).toBe(true);
        expect(offers("pid", "mdl")).toBe(false);
        expect(offers("mdl")).toBe(false);
    });

    it("keeps no issuance session without stored configuration ids", () => {
        expect(withinConfigLimits({}, limits)).toBe(false);
        expect(
            withinConfigLimits({ credentialConfigurationIds: null }, limits),
        ).toBe(false);
        // An offer without configurations is of no allowed configuration.
        expect(
            withinConfigLimits({ credentialConfigurationIds: [] }, limits),
        ).toBe(false);
    });

    it("limits each session type on its own", () => {
        expect(
            withinConfigLimits({ requestId: "mdl" }, { issuance: ["pid"] }),
        ).toBe(true);
        expect(
            withinConfigLimits(
                { credentialConfigurationIds: ["mdl"] },
                { presentation: ["pid"] },
            ),
        ).toBe(true);
    });

    it.each([undefined, {}, { presentation: [], issuance: null }])(
        "keeps every session without limits (%j)",
        (none) => {
            expect(withinConfigLimits({ requestId: "mdl" }, none)).toBe(true);
            expect(withinConfigLimits({}, none)).toBe(true);
        },
    );
});

describe("hasConfigLimits", () => {
    it("tells limits that leave out sessions from empty ones", () => {
        expect(hasConfigLimits(undefined)).toBe(false);
        expect(hasConfigLimits({ presentation: [], issuance: null })).toBe(
            false,
        );
        expect(hasConfigLimits({ presentation: ["pid"] })).toBe(true);
        expect(hasConfigLimits({ issuance: ["pid"] })).toBe(true);
    });
});
