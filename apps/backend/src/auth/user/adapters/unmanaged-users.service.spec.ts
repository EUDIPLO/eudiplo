import { describe, expect, it } from "vitest";
import { UserManagementNotSupported } from "../user.provider.js";
import { UnmanagedUsersProvider } from "./unmanaged-users.service.js";

describe("UnmanagedUsersProvider", () => {
    describe.each([
        [
            "builtin",
            "Human user management is only available when EUDIPLO is configured with Keycloak as its external OIDC provider.",
        ],
        [
            "generic",
            "Users are managed in the identity provider (OIDC_PROVIDER=generic).",
        ],
    ] as const)("%s", (mode, reason) => {
        const provider = new UnmanagedUsersProvider(mode);

        it.each([
            ["getUsers", () => provider.getUsers("acme")],
            ["getUser", () => provider.getUser("acme", "u")],
            ["getUserRoles", () => provider.getUserRoles("acme", "u")],
            ["addUser", () => provider.addUser("acme", {} as never)],
            ["updateUser", () => provider.updateUser("acme", "u", {} as never)],
            ["removeUser", () => provider.removeUser("acme", "u")],
        ])("refuses %s", (_, call) => {
            expect(call).toThrow(new UserManagementNotSupported(mode));
            expect(call).toThrow(reason);
        });
    });
});
