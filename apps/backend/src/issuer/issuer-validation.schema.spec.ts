import { describe, expect, it } from "vitest";
import { VALIDATION_SCHEMA } from "../platform/config/combined.schema.js";

const REQUIRED_ENV = {
    MASTER_SECRET: "a-master-secret-with-at-least-32-characters",
    AUTH_CLIENT_ID: "client",
    AUTH_CLIENT_SECRET: "secret",
};

function internalUrl(env: Record<string, unknown>): unknown {
    const { error, value } = VALIDATION_SCHEMA.validate({
        ...REQUIRED_ENV,
        ...env,
    });
    expect(error).toBeUndefined();
    return value.INTERNAL_URL;
}

describe("INTERNAL_URL default", () => {
    it("is the loopback address on port 3000 without PORT", () => {
        expect(internalUrl({})).toBe("http://127.0.0.1:3000");
    });

    it("follows PORT", () => {
        expect(internalUrl({ PORT: "3199" })).toBe("http://127.0.0.1:3199");
    });

    it.each(["true", "TRUE", true])(
        "is unset with TLS_ENABLED=%s, so PUBLIC_URL is used",
        (tls) => {
            expect(internalUrl({ PORT: "8443", TLS_ENABLED: tls })).toBe(
                undefined,
            );
        },
    );

    it("keeps the loopback address with TLS_ENABLED=false", () => {
        expect(internalUrl({ TLS_ENABLED: "false" })).toBe(
            "http://127.0.0.1:3000",
        );
    });

    it("is unset when PORT is a named pipe", () => {
        expect(internalUrl({ PORT: String.raw`\\.\pipe\eudiplo` })).toBe(
            undefined,
        );
    });

    it("does not replace a configured INTERNAL_URL", () => {
        expect(
            internalUrl({
                PORT: "3199",
                INTERNAL_URL: "http://eudiplo.internal:8080",
            }),
        ).toBe("http://eudiplo.internal:8080");
    });
});
