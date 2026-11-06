import { describe, expect, it } from "vitest";
import { ServiceTypeIdentifiers, type TrustedEntity } from "../types.js";
import {
    getRevocationCert,
    getRevocationServices,
    getStatusListSigners,
} from "./status-list-signers.js";

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

describe("getStatusListSigners", () => {
    const pidIssuance = {
        serviceTypeIdentifier: ServiceTypeIdentifiers.PIDIssuance,
        certValue: "pid-issuance",
    };
    const pidRevocation = {
        serviceTypeIdentifier: ServiceTypeIdentifiers.PIDRevocation,
        certValue: "pid-revocation",
    };
    const walletRevocation = {
        serviceTypeIdentifier: ServiceTypeIdentifiers.WalletSolutionRevocation,
        certValue: "wallet-revocation",
    };

    it("returns the revocation services paired with the matched service", () => {
        expect(
            getStatusListSigners(
                { services: [pidIssuance, walletRevocation, pidRevocation] },
                pidIssuance,
            ),
        ).toEqual([pidRevocation]);
    });

    it("returns the matched service when no revocation service is paired with it", () => {
        expect(
            getStatusListSigners(
                { services: [pidIssuance, walletRevocation] },
                pidIssuance,
            ),
        ).toEqual([pidIssuance]);
    });
});
