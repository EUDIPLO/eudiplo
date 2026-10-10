import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    relyingPartyControllerFindAll,
    relyingPartyControllerRegister,
} from "./generated/index.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";

vi.mock("./generated/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./generated/index.js")>()),
    relyingPartyControllerFindAll: vi.fn(),
    relyingPartyControllerRegister: vi.fn(),
}));

describe("RegistrarAuthService.getRelyingPartyId", () => {
    let service: RegistrarAuthService;

    beforeEach(() => {
        vi.mocked(relyingPartyControllerFindAll).mockReset();
        vi.mocked(relyingPartyControllerRegister).mockReset();
        service = new RegistrarAuthService({} as any);
        vi.spyOn(service, "getClient").mockResolvedValue({} as any);
    });

    it("returns the first existing relying party without registering one", async () => {
        vi.mocked(relyingPartyControllerFindAll).mockResolvedValue({
            data: [{ id: "rp-1" }, { id: "rp-2" }],
        } as any);

        await expect(service.getRelyingPartyId("tenant")).resolves.toBe("rp-1");
        expect(relyingPartyControllerRegister).not.toHaveBeenCalled();
    });

    it("registers a relying party when none exists", async () => {
        vi.mocked(relyingPartyControllerFindAll).mockResolvedValue({
            data: [],
        } as any);
        vi.mocked(relyingPartyControllerRegister).mockResolvedValue({
            data: { id: "rp-new" },
        } as any);

        await expect(service.getRelyingPartyId("tenant")).resolves.toBe(
            "rp-new",
        );
    });

    it("throws a BadRequestException when the registrar rejects the registration", async () => {
        vi.mocked(relyingPartyControllerFindAll).mockResolvedValue({
            data: [],
        } as any);
        vi.mocked(relyingPartyControllerRegister).mockResolvedValue({
            data: undefined,
            error: { statusCode: 403, message: "Forbidden" },
        } as any);

        await expect(service.getRelyingPartyId("tenant")).rejects.toThrow(
            new BadRequestException(
                "Failed to register relying party at registrar",
            ),
        );
    });
});
