import { describe, expect, it } from "vitest";
import {
    CreateRegistrarConfigSchema,
    UpdateRegistrarConfigSchema,
} from "./registrar.schema.js";

describe("registrar config URLs", () => {
    const config = {
        registrarUrl: "https://registrar.example/api",
        oidcUrl: "https://auth.example/realms/registrar",
        clientId: "client",
        username: "user",
        password: "password",
    };

    it("accepts plain http(s) base URLs", () => {
        expect(CreateRegistrarConfigSchema.safeParse(config).success).toBe(
            true,
        );
        expect(
            UpdateRegistrarConfigSchema.safeParse({
                registrarUrl: "http://registrar.example:3001",
            }).success,
        ).toBe(true);
    });

    it.each([
        // A trailing "#" swallows the API path the client appends.
        "https://registrar.example/#",
        "https://registrar.example/#/admin",
        "https://registrar.example/?",
        "https://registrar.example/?target=internal",
        "https://user:secret@registrar.example",
        "ftp://registrar.example",
        "file:///etc/passwd",
    ])("rejects %s", (url) => {
        for (const field of ["registrarUrl", "oidcUrl"] as const) {
            expect(
                CreateRegistrarConfigSchema.safeParse({
                    ...config,
                    [field]: url,
                }).success,
            ).toBe(false);
            expect(
                UpdateRegistrarConfigSchema.safeParse({ [field]: url }).success,
            ).toBe(false);
        }
    });
});
