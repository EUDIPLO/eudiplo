import { describe, expect, it } from "vitest";
import { ServiceTypeIdentifiers } from "../types.js";
import {
    effectiveServiceType,
    LoteTypes,
    loteProfileRules,
    ServiceStatuses,
    serviceStatusVerdict,
} from "./lote-profiles.js";

const UNKNOWN_STATUS = "https://scheme.example.org/status/approved";

describe("loteProfileRules", () => {
    it.each([
        [LoteTypes.PIDProviders, ServiceTypeIdentifiers.PIDIssuance],
        [
            LoteTypes.WalletProviders,
            ServiceTypeIdentifiers.WalletSolutionIssuance,
        ],
        [LoteTypes.PubEAAProviders, ServiceTypeIdentifiers.PubEaaIssuance],
        [LoteTypes.EAAProviders, ServiceTypeIdentifiers.EaaIssuance],
    ])("implies the issuance type for %s", (loteType, implied) => {
        expect(loteProfileRules(loteType).impliedServiceType).toBe(implied);
    });

    it.each([
        LoteTypes.WRPACProviders,
        LoteTypes.WRPRCProviders,
        LoteTypes.RegistrarsAndRegisters,
        "https://scheme.example.org/LoTEType/Members",
        undefined,
    ])("implies no type for %s", (loteType) => {
        expect(loteProfileRules(loteType).impliedServiceType).toBeUndefined();
    });
});

describe("serviceStatusVerdict", () => {
    describe("Pub-EAA providers list (Annex H)", () => {
        const rules = loteProfileRules(LoteTypes.PubEAAProviders);

        it("reads a notified service", () => {
            expect(
                serviceStatusVerdict(rules, ServiceStatuses.PubEAANotified),
            ).toEqual({ keep: true });
        });

        it("reads a service without status, with a warning", () => {
            expect(serviceStatusVerdict(rules, undefined)).toEqual({
                keep: true,
                note: "status-missing",
            });
        });

        it.each([
            [ServiceStatuses.PubEAAWithdrawn, "status-withdrawn"],
            [ServiceStatuses.SchemeApprovalWithdrawn, "status-withdrawn"],
            [ServiceStatuses.SchemeApprovalGranted, "status-unknown"],
            [UNKNOWN_STATUS, "status-unknown"],
        ])("leaves out a service with status %s", (status, note) => {
            expect(serviceStatusVerdict(rules, status)).toEqual({
                keep: false,
                note,
            });
        });
    });

    describe.each([
        LoteTypes.PIDProviders,
        LoteTypes.WalletProviders,
        LoteTypes.WRPACProviders,
        LoteTypes.WRPRCProviders,
        LoteTypes.RegistrarsAndRegisters,
    ])("%s, where ServiceStatus shall not be used", (loteType) => {
        const rules = loteProfileRules(loteType);

        it("reads a service without status", () => {
            expect(serviceStatusVerdict(rules, undefined)).toEqual({
                keep: true,
            });
        });

        it.each([
            [ServiceStatuses.PubEAANotified, "status-not-used"],
            [ServiceStatuses.SchemeApprovalGranted, "status-not-used"],
            [UNKNOWN_STATUS, "status-not-used"],
            [ServiceStatuses.SchemeApprovalWithdrawn, "status-withdrawn"],
        ])("leaves out a service with status %s", (status, note) => {
            expect(serviceStatusVerdict(rules, status)).toEqual({
                keep: false,
                note,
            });
        });
    });

    describe.each([
        LoteTypes.EAAProviders,
        "https://scheme.example.org/LoTEType/Members",
        undefined,
    ])("list type %s of no EU profile", (loteType) => {
        const rules = loteProfileRules(loteType);

        it.each([
            undefined,
            ServiceStatuses.PubEAANotified,
            ServiceStatuses.SchemeApprovalGranted,
        ])("reads a service with status %s", (status) => {
            expect(serviceStatusVerdict(rules, status)).toEqual({
                keep: true,
            });
        });

        it.each([
            [ServiceStatuses.PubEAAWithdrawn, "status-withdrawn"],
            [ServiceStatuses.SchemeApprovalWithdrawn, "status-withdrawn"],
            [UNKNOWN_STATUS, "status-unknown"],
        ])("leaves out a service with status %s", (status, note) => {
            expect(serviceStatusVerdict(rules, status)).toEqual({
                keep: false,
                note,
            });
        });
    });
});

describe("effectiveServiceType", () => {
    const pid = loteProfileRules(LoteTypes.PIDProviders);

    it("keeps a service's own type", () => {
        expect(
            effectiveServiceType(
                pid,
                ServiceTypeIdentifiers.PIDRevocation,
                true,
            ),
        ).toEqual({ type: ServiceTypeIdentifiers.PIDRevocation });
    });

    it("implies the list's type when no service has one", () => {
        expect(effectiveServiceType(pid, undefined, false)).toEqual({
            type: ServiceTypeIdentifiers.PIDIssuance,
        });
    });

    it("gives no type to an untyped service of a mixed list", () => {
        expect(effectiveServiceType(pid, undefined, true)).toEqual({
            note: "untyped-in-mixed-list",
        });
    });

    it("gives no type when the list type implies none", () => {
        expect(
            effectiveServiceType(
                loteProfileRules(LoteTypes.WRPACProviders),
                undefined,
                false,
            ),
        ).toEqual({ note: "untyped-without-implied-type" });
    });
});
