import { describe, expect, it } from "vitest";
import { formatBlockingIssue } from "./config-import-orchestrator.service.js";

describe("formatBlockingIssue", () => {
    it("names the resource the issue belongs to", () => {
        expect(
            formatBlockingIssue({
                severity: "error",
                code: "TRUSTED_AUTHORITY_REQUIRED",
                path: "/spec/dcql_query/credentials",
                message: "Credential queries without trusted_authorities: pid.",
                resource: { kind: "PresentationConfig", id: "pid-request" },
            }),
        ).toBe(
            "TRUSTED_AUTHORITY_REQUIRED in PresentationConfig/pid-request at /spec/dcql_query/credentials: Credential queries without trusted_authorities: pid.",
        );
    });

    it("falls back to the bundle when the issue has no resource", () => {
        expect(
            formatBlockingIssue({
                severity: "required-input",
                code: "MISSING_INPUT",
                path: "/inputs",
                message: "Input missing.",
            }),
        ).toBe("MISSING_INPUT in bundle at /inputs: Input missing.");
    });
});
