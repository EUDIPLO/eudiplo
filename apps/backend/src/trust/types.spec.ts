import { describe, expect, it } from "vitest";
import {
    getRevocationCert,
    getRevocationServices,
    ServiceTypeIdentifiers,
    TrustedEntity,
} from "./types.js";

describe("getRevocationCert", () => {
    const walletRevocation = {
        serviceTypeIdentifier: ServiceTypeIdentifiers.WalletSolutionRevocation,
        certValue: "wallet-revocation",
    };
    const eaaRevocation = {
        serviceTypeIdentifier: ServiceTypeIdentifiers.EaaRevocation,
        certValue: "eaa-revocation",
    };
    const both: TrustedEntity = { services: [eaaRevocation, walletRevocation] };

    it("prefers WalletSolution/Revocation for a wallet solution service", () => {
        expect(
            getRevocationCert(both, ServiceTypeIdentifiers.WalletSolution),
        ).toBe(walletRevocation);
    });

    it("falls back to EAA/Revocation for a wallet solution service", () => {
        expect(
            getRevocationCert(
                { services: [eaaRevocation] },
                ServiceTypeIdentifiers.WalletSolutionIssuance,
            ),
        ).toBe(eaaRevocation);
    });

    it("uses EAA/Revocation for other services", () => {
        expect(
            getRevocationCert(both, ServiceTypeIdentifiers.EaaIssuance),
        ).toBe(eaaRevocation);
    });

    it("ignores WalletSolution/Revocation for other services", () => {
        expect(
            getRevocationCert(
                { services: [walletRevocation] },
                ServiceTypeIdentifiers.EaaIssuance,
            ),
        ).toBeUndefined();
    });
});

describe("getRevocationServices", () => {
    const service = (serviceTypeIdentifier: string, certValue: string) => ({
        serviceTypeIdentifier,
        certValue,
    });
    const eaaRevocation = service(
        ServiceTypeIdentifiers.EaaRevocation,
        "eaa-revocation",
    );

    it.each([
        [
            ServiceTypeIdentifiers.PIDIssuance,
            ServiceTypeIdentifiers.PIDRevocation,
        ],
        [
            ServiceTypeIdentifiers.PubEaaIssuance,
            ServiceTypeIdentifiers.PubEaaRevocation,
        ],
        [
            ServiceTypeIdentifiers.WalletSolutionIssuance,
            ServiceTypeIdentifiers.WalletSolutionRevocation,
        ],
    ])("pairs %s with %s", (issuance, revocation) => {
        const paired = service(revocation, "paired");
        expect(
            getRevocationServices(
                { services: [eaaRevocation, paired] },
                issuance,
            ),
        ).toEqual([paired]);
    });

    it("returns every revocation service of the paired type", () => {
        const first = service(
            ServiceTypeIdentifiers.WalletSolutionRevocation,
            "first",
        );
        const second = service(
            ServiceTypeIdentifiers.WalletSolutionRevocation,
            "second",
        );
        expect(
            getRevocationServices(
                {
                    services: [
                        first,
                        service(
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                            "issuance",
                        ),
                        second,
                    ],
                },
                ServiceTypeIdentifiers.WalletSolutionIssuance,
            ),
        ).toEqual([first, second]);
    });

    it("falls back to EAA/Revocation when the paired type is not listed", () => {
        expect(
            getRevocationServices(
                { services: [eaaRevocation] },
                ServiceTypeIdentifiers.PubEaaIssuance,
            ),
        ).toEqual([eaaRevocation]);
    });

    it("does not use the revocation service of another profile", () => {
        expect(
            getRevocationServices(
                {
                    services: [
                        service(ServiceTypeIdentifiers.PIDRevocation, "pid"),
                    ],
                },
                ServiceTypeIdentifiers.PubEaaIssuance,
            ),
        ).toEqual([]);
    });
});
