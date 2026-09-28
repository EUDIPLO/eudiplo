import type { CredentialOfferObject } from "@openid4vc/openid4vci";
import { describe, expect, it, vi } from "vitest";
import type { SessionRepository } from "../../../../session/ports/session.repository.js";
import {
    CredentialOfferNotFound,
    RetrieveCredentialOffer,
} from "./retrieve-credential-offer.js";

const offer: CredentialOfferObject = {
    credential_issuer: "https://issuer.example/tenant-a",
    credential_configuration_ids: ["pid"],
};
function setup(allowMultipleConsumption = false) {
    const repository = {
        findCredentialOffer: vi
            .fn<SessionRepository["findCredentialOffer"]>()
            .mockResolvedValue({ offer }),
        consumeCredentialOffer: vi
            .fn<SessionRepository["consumeCredentialOffer"]>()
            .mockResolvedValue(true),
    };
    return {
        repository,
        useCase: new RetrieveCredentialOffer(repository, {
            allowMultipleConsumption,
        }),
    };
}

describe("RetrieveCredentialOffer", () => {
    it("returns the offer only after tenant-scoped consumption succeeds", async () => {
        const { repository, useCase } = setup();
        await expect(useCase.execute("tenant-a", "session-a")).resolves.toEqual(
            offer,
        );
        expect(repository.findCredentialOffer).toHaveBeenCalledWith(
            "tenant-a",
            "session-a",
        );
        expect(repository.consumeCredentialOffer).toHaveBeenCalledWith(
            "tenant-a",
            "session-a",
        );
    });

    it.each([null, { offer: null }])(
        "does not consume a missing offer: %j",
        async (value) => {
            const { repository, useCase } = setup();
            repository.findCredentialOffer.mockResolvedValue(value);
            await expect(
                useCase.execute("tenant-a", "session-a"),
            ).rejects.toBeInstanceOf(CredentialOfferNotFound);
            expect(repository.consumeCredentialOffer).not.toHaveBeenCalled();
        },
    );

    it("does not return a stale read when another consumer won", async () => {
        const { repository, useCase } = setup();
        repository.consumeCredentialOffer.mockResolvedValue(false);
        await expect(
            useCase.execute("tenant-a", "session-a"),
        ).rejects.toBeInstanceOf(CredentialOfferNotFound);
    });

    it("preserves lookup error mapping and its diagnostic cause", async () => {
        const { repository, useCase } = setup();
        const cause = new Error("database unavailable");
        repository.findCredentialOffer.mockRejectedValue(cause);
        await expect(
            useCase.execute("tenant-a", "session-a"),
        ).rejects.toMatchObject({ name: "CredentialOfferNotFound", cause });
        expect(repository.consumeCredentialOffer).not.toHaveBeenCalled();
    });

    it("propagates write failures rather than misreporting successful consumption", async () => {
        const { repository, useCase } = setup();
        const cause = new Error("write failed");
        repository.consumeCredentialOffer.mockRejectedValue(cause);
        await expect(useCase.execute("tenant-a", "session-a")).rejects.toBe(
            cause,
        );
    });

    it.each([offer, null])(
        "does not mutate session state in multiple-consumption mode",
        async (value) => {
            const { repository, useCase } = setup(true);
            repository.findCredentialOffer.mockResolvedValue({ offer: value });
            await expect(
                useCase.execute("tenant-a", "session-a"),
            ).resolves.toEqual(value);
            expect(repository.consumeCredentialOffer).not.toHaveBeenCalled();
        },
    );
});
