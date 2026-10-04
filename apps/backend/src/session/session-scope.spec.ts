import { describe, expect, it } from "vitest";
import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import { sessionScope } from "./session-scope.js";

const token = (roles: Role[]) => ({ roles }) as TokenPayload;

describe("sessionScope", () => {
    it.each([
        [[Role.PresentationRequest], "presentation"],
        [[Role.PresentationRequest, Role.Presentations], "presentation"],
        [[Role.IssuanceOffer], "issuance"],
        [[Role.IssuanceOffer, Role.Issuances], "issuance"],
        [[Role.IssuanceOffer, Role.PresentationRequest], undefined],
        [[Role.IssuanceOffer, Role.Presentations], undefined],
        [[Role.PresentationRequest, Role.Issuances], undefined],
    ])("limits a client with %j to %s sessions", (roles, scope) => {
        expect(sessionScope(token(roles))).toBe(scope);
    });

    it("rejects a token without a session role instead of widening the scope", () => {
        expect(() => sessionScope(token([Role.Clients]))).toThrow(
            "Token has no role that grants access to sessions",
        );
    });
});
