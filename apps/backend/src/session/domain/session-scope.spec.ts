import { describe, expect, it } from "vitest";
import { Role } from "../../auth/roles/role.enum.js";
import {
    credentialStatusScope,
    mayChangeSessions,
    readOnlySessionTypes,
    sessionChangeScope,
    sessionReadScope,
} from "./session-scope.js";

const token = (roles: Role[]) => ({ roles });

const sideRoleCases = [
    [[Role.PresentationRequest], "presentation"],
    [[Role.PresentationRequest, Role.Presentations], "presentation"],
    [[Role.IssuanceOffer], "issuance"],
    [[Role.IssuanceOffer, Role.Issuances], "issuance"],
    [[Role.IssuanceOffer, Role.PresentationRequest], undefined],
    [[Role.IssuanceOffer, Role.Presentations], undefined],
    [[Role.PresentationRequest, Role.Issuances], undefined],
] as const;

describe("sessionChangeScope", () => {
    it.each(sideRoleCases)(
        "limits a client with %j to %s sessions",
        (roles, scope) => {
            expect(sessionChangeScope(token([...roles]))).toBe(scope);
        },
    );

    it.each([
        [[Role.SessionsRead, Role.PresentationRequest], "presentation"],
        [[Role.SessionsRead, Role.IssuanceOffer], "issuance"],
        [[Role.CredentialStatus, Role.PresentationRequest], "presentation"],
    ])(
        "does not widen the changes of a client with %j beyond %s sessions",
        (roles, scope) => {
            expect(sessionChangeScope(token(roles))).toBe(scope);
        },
    );

    it.each([
        [[Role.Clients]],
        [[Role.SessionsRead]],
        [[Role.CredentialStatus]],
    ])("rejects a token with %j instead of widening the scope", (roles) => {
        expect(() => sessionChangeScope(token(roles))).toThrow(
            "Token has no role that grants access to sessions",
        );
    });
});

describe("mayChangeSessions", () => {
    it.each([
        [[Role.IssuanceOffer], "issuance", true],
        // A manage role counts toward a side only with a role that changes sessions.
        [[Role.SessionsRead, Role.Issuances], "issuance", false],
        [[Role.SessionsRead, Role.Issuances], "presentation", false],
        [[Role.PresentationRequest, Role.Issuances], "issuance", true],
        [[Role.PresentationRequest], "presentation", true],
        [[Role.SessionsRead, Role.Presentations], "presentation", false],
        [[Role.IssuanceOffer, Role.Presentations], "presentation", true],
        [[Role.SessionsRead], "issuance", false],
        [[Role.SessionsRead], "presentation", false],
        [[Role.SessionsRead, Role.CredentialStatus], "issuance", false],
    ] as const)(
        "lets a client with %j change %s sessions: %s",
        (roles, type, allowed) => {
            expect(mayChangeSessions(token([...roles]), type)).toBe(allowed);
        },
    );
});

describe("readOnlySessionTypes", () => {
    it.each([
        [[Role.SessionsRead], ["issuance", "presentation"]],
        [[Role.SessionsRead, Role.IssuanceOffer], ["presentation"]],
        [
            [Role.SessionsRead, Role.Presentations],
            ["issuance", "presentation"],
        ],
        [
            [Role.SessionsRead, Role.Issuances],
            ["issuance", "presentation"],
        ],
        [[Role.SessionsRead, Role.PresentationRequest, Role.Issuances], []],
        [[Role.IssuanceOffer, Role.PresentationRequest], []],
        [
            [Role.SessionsRead, Role.CredentialStatus],
            ["issuance", "presentation"],
        ],
        // Without sessions:read nothing changes for the older role sets.
        [[Role.Issuances], []],
        [[Role.CredentialStatus], []],
        [[Role.PresentationRequest], []],
    ])("treats %j as read-only for %j sessions", (roles, types) => {
        expect(readOnlySessionTypes(token(roles))).toEqual(types);
    });
});

describe("sessionReadScope", () => {
    it.each(sideRoleCases)(
        "limits a client with %j to %s sessions",
        (roles, scope) => {
            expect(sessionReadScope(token([...roles]))).toBe(scope);
        },
    );

    it.each([
        [[Role.SessionsRead]],
        [[Role.SessionsRead, Role.PresentationRequest]],
        [[Role.SessionsRead, Role.IssuanceOffer]],
    ])("reads both session types with %j", (roles) => {
        expect(sessionReadScope(token(roles))).toBeUndefined();
    });

    it("gives credentials:status no read access to sessions", () => {
        expect(
            sessionReadScope(
                token([Role.CredentialStatus, Role.PresentationRequest]),
            ),
        ).toBe("presentation");
        expect(() => sessionReadScope(token([Role.CredentialStatus]))).toThrow(
            "Token has no role that grants access to sessions",
        );
    });
});

describe("credentialStatusScope", () => {
    it.each([
        ...sideRoleCases,
        [[Role.CredentialStatus], "issuance"],
        [[Role.CredentialStatus, Role.PresentationRequest], undefined],
        [[Role.SessionsRead], undefined],
    ] as const)(
        "reads the credential status of a client with %j in %s sessions",
        (roles, scope) => {
            expect(credentialStatusScope(token([...roles]))).toBe(scope);
        },
    );

    it("rejects a token without a session role", () => {
        expect(() => credentialStatusScope(token([Role.Clients]))).toThrow(
            "Token has no role that grants access to sessions",
        );
    });
});
