import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuanceConfigurationNotFound } from "../../../configuration/issuance/domain/issuance-configuration.js";
import type { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import type { IssuerRegistrationCertificateProvider } from "../ports/issuer-registration-certificate-provider.js";
import {
    IssuerRegistrationCertificateRenewalListener,
    RENEWAL_DEBOUNCE_MS,
} from "./issuer-registration-certificate-renewal.listener.js";

function setup(
    registrationCertificate: unknown,
    getIssuanceConfiguration: () => Promise<unknown> = async () => ({
        registrationCertificate,
    }),
) {
    const certificates = { resolve: vi.fn(async () => "jwt") };
    const issuance = {
        getIssuanceConfiguration: vi.fn(getIssuanceConfiguration),
    };
    const listener = new IssuerRegistrationCertificateRenewalListener(
        certificates as unknown as IssuerRegistrationCertificateProvider,
        issuance as unknown as IssuanceService,
    );
    return { listener, certificates };
}

describe("IssuerRegistrationCertificateRenewalListener", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("renews once per tenant after a burst of changes", async () => {
        const settings = { enabled: true, mode: "generate" };
        const { listener, certificates } = setup(settings);

        listener.onInputsChanged({ tenantId: "t" });
        listener.onInputsChanged({ tenantId: "t" });
        await vi.advanceTimersByTimeAsync(RENEWAL_DEBOUNCE_MS - 1);
        listener.onInputsChanged({ tenantId: "t" });
        await vi.advanceTimersByTimeAsync(RENEWAL_DEBOUNCE_MS);

        expect(certificates.resolve).toHaveBeenCalledOnce();
        expect(certificates.resolve).toHaveBeenCalledWith("t", settings);
    });

    it.each([
        ["disabled", { enabled: false, mode: "generate" }],
        ["import mode", { enabled: true, mode: "import" }],
        [
            "renewal on metadata request",
            { enabled: true, renewal: "onMetadataRequest" },
        ],
        ["manual renewal", { enabled: true, renewal: "manual" }],
        ["no settings", undefined],
    ])("does nothing for %s", async (_name, settings) => {
        const { listener, certificates } = setup(settings);
        await listener.renew("t");
        expect(certificates.resolve).not.toHaveBeenCalled();
    });

    it("does nothing without an issuance configuration", async () => {
        const { listener, certificates } = setup(undefined, () =>
            Promise.reject(new IssuanceConfigurationNotFound("t")),
        );
        await listener.renew("t");
        expect(certificates.resolve).not.toHaveBeenCalled();
    });

    it("passes on other errors reading the issuance configuration", async () => {
        const { listener } = setup(undefined, () =>
            Promise.reject(new Error("database down")),
        );
        await expect(listener.renew("t")).rejects.toThrow("database down");
    });

    it("debounces each tenant on its own", async () => {
        const { listener, certificates } = setup({ enabled: true });
        listener.onInputsChanged({ tenantId: "a" });
        listener.onInputsChanged({ tenantId: "b" });
        await vi.advanceTimersByTimeAsync(RENEWAL_DEBOUNCE_MS);
        expect(
            certificates.resolve.mock.calls.map(([tenantId]) => tenantId),
        ).toEqual(["a", "b"]);
    });

    it("logs a failed background renewal instead of rejecting", async () => {
        const warn = vi
            .spyOn(Logger.prototype, "warn")
            .mockImplementation(() => undefined);
        const { listener } = setup(undefined, () =>
            Promise.reject(new Error("database down")),
        );

        listener.onInputsChanged({ tenantId: "t" });
        await vi.advanceTimersByTimeAsync(RENEWAL_DEBOUNCE_MS);

        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("Background renewal"),
        );
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("database down"),
        );
        warn.mockRestore();
    });

    it("drops pending renewals on shutdown", async () => {
        const { listener, certificates } = setup({ enabled: true });
        listener.onInputsChanged({ tenantId: "t" });
        listener.onModuleDestroy();
        await vi.advanceTimersByTimeAsync(RENEWAL_DEBOUNCE_MS);
        expect(certificates.resolve).not.toHaveBeenCalled();
    });
});
