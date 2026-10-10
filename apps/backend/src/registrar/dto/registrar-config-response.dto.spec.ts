import { describe, expect, it } from "vitest";
import type { RegistrarConfigEntity } from "../entities/registrar-config.entity.js";
import { RegistrarConfigResponseDto } from "./registrar-config-response.dto.js";

describe("RegistrarConfigResponseDto.fromEntity", () => {
    const entity = {
        tenantId: "tenant-1",
        registrarUrl: "https://registrar.example",
        oidcUrl: "https://auth.example",
        clientId: "client",
        clientSecret: "client-secret",
        username: "user",
        password: "password",
    } as RegistrarConfigEntity;

    it("returns neither password nor client secret, only whether they are set", () => {
        const dto = RegistrarConfigResponseDto.fromEntity(entity);

        expect(dto).not.toHaveProperty("password");
        expect(dto).not.toHaveProperty("clientSecret");
        expect(dto).toMatchObject({ hasPassword: true, hasClientSecret: true });
    });

    it("reports a missing client secret", () => {
        expect(
            RegistrarConfigResponseDto.fromEntity({
                ...entity,
                clientSecret: undefined,
            }).hasClientSecret,
        ).toBe(false);
    });
});
