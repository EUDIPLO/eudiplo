import { describe, expect, it } from "vitest";
import { PresentationRequestSchema } from "./presentation-request.schema.js";

describe("PresentationRequestSchema inline webhook", () => {
    const body = (url: string) => ({
        response_type: "uri",
        requestId: "pid",
        webhook: { url, auth: { type: "none" } },
    });

    it("accepts an inline webhook", () => {
        expect(
            PresentationRequestSchema.safeParse(body("https://hooks.example"))
                .success,
        ).toBe(true);
    });

    it("rejects an inline webhook with an empty URL", () => {
        const result = PresentationRequestSchema.safeParse(body(""));

        expect(result.error?.issues.map(({ path }) => path)).toEqual([
            ["webhook", "url"],
        ]);
    });
});
