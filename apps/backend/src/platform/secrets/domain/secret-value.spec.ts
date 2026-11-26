import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretValue } from "./secret-value.js";

describe("SecretValue", () => {
    const value = new SecretValue("s3cr3t-value");

    it("gives the value only through reveal", () => {
        expect(value.reveal()).toBe("s3cr3t-value");
    });

    it("never prints the value", () => {
        const outputs = [
            JSON.stringify({ auth: value, list: [value] }),
            inspect({ nested: { value } }, { depth: 10, showHidden: true }),
            format("%s %o %O %j", value, value, value, value),
            `${value}`,
            String(value),
            JSON.stringify({ ...value }),
            Object.keys(value).join(","),
        ];
        for (const output of outputs) expect(output).not.toContain("s3cr3t");
        expect(JSON.stringify({ auth: value })).toBe('{"auth":"[secret]"}');
    });

    it("keeps the value out of an error that wraps it", () => {
        const error = new Error(`failed with ${value}`, { cause: value });
        expect(inspect(error)).not.toContain("s3cr3t");
    });
});
