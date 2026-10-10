import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrarConfigService } from "./registrar-config.service.js";

describe("RegistrarConfigService URL checks", () => {
    const existing = {
        tenantId: "tenant",
        registrarUrl: "https://registrar.example",
        oidcUrl: "https://auth.example",
        clientId: "client",
        username: "user",
        password: "password",
    };
    let repository: { findOneBy: any; save: any; findOneByOrFail: any };
    let authService: {
        assertSafeUrls: any;
        testCredentials: any;
        invalidateToken: any;
    };
    let service: RegistrarConfigService;

    beforeEach(() => {
        repository = {
            findOneBy: vi.fn().mockResolvedValue(existing),
            save: vi.fn(async (value) => value),
            findOneByOrFail: vi.fn().mockResolvedValue(existing),
        };
        authService = {
            assertSafeUrls: vi
                .fn()
                .mockRejectedValue(
                    new BadRequestException(
                        "Outbound URL target resolves to a private or loopback IP",
                    ),
                ),
            testCredentials: vi.fn().mockResolvedValue(undefined),
            invalidateToken: vi.fn(),
        };
        service = new RegistrarConfigService(
            {} as any,
            { register: vi.fn() } as any,
            repository as any,
            authService as any,
            {} as any,
            {} as any,
            {} as any,
        );
    });

    it("checks a registrar URL changed on its own", async () => {
        // No auth field changes, so no credential check sends a request.
        const dto = { registrarUrl: "https://internal.example" };

        await expect(service.updateConfig("tenant", dto)).rejects.toThrow(
            "private or loopback IP",
        );
        expect(authService.assertSafeUrls).toHaveBeenCalledWith(dto);
        expect(repository.save).not.toHaveBeenCalled();
    });

    it("checks both URLs before testing the credentials on save", async () => {
        await expect(
            service.saveConfig("tenant", existing),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(authService.assertSafeUrls).toHaveBeenCalledWith(existing);
        expect(authService.testCredentials).not.toHaveBeenCalled();
        expect(repository.save).not.toHaveBeenCalled();
    });
});
