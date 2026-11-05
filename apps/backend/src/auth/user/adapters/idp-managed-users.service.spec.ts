import { describe, expect, it } from "vitest";
import { UsersManagedByIdentityProvider } from "../user.provider.js";
import { IdpManagedUsersProvider } from "./idp-managed-users.service.js";

describe("IdpManagedUsersProvider", () => {
    const provider = new IdpManagedUsersProvider();

    it.each([
        ["getUsers", () => provider.getUsers("acme")],
        ["getUser", () => provider.getUser("acme", "u")],
        ["getUserRoles", () => provider.getUserRoles("acme", "u")],
        ["addUser", () => provider.addUser("acme", {} as never)],
        ["updateUser", () => provider.updateUser("acme", "u", {} as never)],
        ["removeUser", () => provider.removeUser("acme", "u")],
    ])("refuses %s", (_, call) => {
        expect(call).toThrow(UsersManagedByIdentityProvider);
    });
});
