import { describe, expect, it } from "vitest";
import {
    PID_MAX_VALIDITY_WITHOUT_STATUS_SECONDS,
    pidWithoutStatusProblem,
} from "./pid-status-requirement.js";

const DAY = 24 * 60 * 60;
const validFrom = 1_800_000_000;

describe("pidWithoutStatusProblem", () => {
    it("names a PID valid for more than 24 hours", () => {
        expect(
            pidWithoutStatusProblem({
                pid: true,
                validFrom,
                validUntil: validFrom + 30 * DAY,
            }),
        ).toMatch(/PID carries no status information/);
    });

    it("names a PID that does not expire", () => {
        expect(
            pidWithoutStatusProblem({
                pid: true,
                validFrom,
                validUntil: undefined,
            }),
        ).toBeDefined();
    });

    it.each([
        ["exactly 24 hours", PID_MAX_VALIDITY_WITHOUT_STATUS_SECONDS],
        ["an hour", 3600],
    ])("accepts a PID valid for %s", (_, seconds) => {
        expect(
            pidWithoutStatusProblem({
                pid: true,
                validFrom,
                validUntil: validFrom + seconds,
            }),
        ).toBeUndefined();
    });

    it("counts one second more than 24 hours", () => {
        expect(
            pidWithoutStatusProblem({
                pid: true,
                validFrom,
                validUntil:
                    validFrom + PID_MAX_VALIDITY_WITHOUT_STATUS_SECONDS + 1,
            }),
        ).toBeDefined();
    });

    it("names a PID without a start of its validity period", () => {
        expect(
            pidWithoutStatusProblem({
                pid: true,
                validFrom: undefined,
                validUntil: validFrom + 3600,
            }),
        ).toBeDefined();
    });

    it("does not apply to other credentials", () => {
        expect(
            pidWithoutStatusProblem({
                pid: false,
                validFrom: undefined,
                validUntil: undefined,
            }),
        ).toBeUndefined();
    });
});
