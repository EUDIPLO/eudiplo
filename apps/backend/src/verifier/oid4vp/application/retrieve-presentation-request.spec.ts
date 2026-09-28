import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import { RetrievePresentationRequest } from "./retrieve-presentation-request.js";

const session = (requestObject?: string) =>
    ({
        id: "session-1",
        tenantId: "tenant-1",
        requestObject,
    }) as SessionData;

describe("RetrievePresentationRequest", () => {
    it("returns the cached JWT without regenerating it", async () => {
        const update = vi.fn();
        const generate = vi.fn();
        const useCase = new RetrievePresentationRequest({
            updateForTenant: update,
        });

        await expect(
            useCase.execute(
                session("cached.jwt.value"),
                "https://wallet.example",
                false,
                generate,
            ),
        ).resolves.toBe("cached.jwt.value");
        expect(generate).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("clears redirect state for a cached no-redirect request", async () => {
        const update = vi.fn().mockResolvedValue(1);
        const useCase = new RetrievePresentationRequest({
            updateForTenant: update,
        });

        await expect(
            useCase.execute(
                session("cached.jwt.value"),
                "origin",
                true,
                vi.fn(),
            ),
        ).resolves.toBe("cached.jwt.value");
        expect(update).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            {
                redirectUri: null,
            },
        );
    });

    it("generates once and persists the request object", async () => {
        const update = vi.fn().mockResolvedValue(1);
        const generate = vi.fn().mockResolvedValue("generated.jwt.value");
        const useCase = new RetrievePresentationRequest({
            updateForTenant: update,
        });

        await expect(
            useCase.execute(
                session(),
                "https://wallet.example",
                false,
                generate,
            ),
        ).resolves.toBe("generated.jwt.value");
        expect(generate).toHaveBeenCalledExactlyOnceWith(
            "session-1",
            "https://wallet.example",
            false,
        );
        expect(update).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            {
                requestObject: "generated.jwt.value",
            },
        );
    });
});
