import { randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataEncryptionService } from "./data-encryption.service.js";
import type { EncryptionKeyProvider } from "./providers/encryption-key-provider.interface.js";

function provider(key = randomBytes(32)) {
    return {
        name: "test",
        getKey: vi.fn(() => Promise.resolve(key)),
    } satisfies EncryptionKeyProvider;
}

async function initialized(keyProvider = provider()) {
    const service = new DataEncryptionService(keyProvider);
    await service.initialize();
    return service;
}

describe("DataEncryptionService", () => {
    beforeEach(() => {
        vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    });

    it("decrypts what it encrypted", async () => {
        const service = await initialized();

        const encrypted = service.encrypt("client-secret ✓");

        expect(encrypted).not.toContain("client-secret");
        expect(service.decrypt(encrypted)).toBe("client-secret ✓");
    });

    it("uses a fresh IV for every value", async () => {
        const service = await initialized();

        expect(service.encrypt("same")).not.toBe(service.encrypt("same"));
    });

    it("fetches the key only once", async () => {
        const keyProvider = provider();
        const service = await initialized(keyProvider);

        await service.initialize();

        expect(keyProvider.getKey).toHaveBeenCalledTimes(1);
    });

    it("refuses to work before initialize", () => {
        const service = new DataEncryptionService(provider());

        expect(() => service.encrypt("value")).toThrow("not initialized");
        expect(() => service.decrypt("a:b:c")).toThrow("not initialized");
    });

    it("rejects a value that is not iv:authTag:ciphertext", async () => {
        const service = await initialized();

        expect(() => service.decrypt("not-encrypted")).toThrow(
            "Invalid encrypted value format",
        );
    });

    it("rejects a changed ciphertext", async () => {
        const service = await initialized();
        const [iv, tag, ciphertext] = service.encrypt("value").split(":");
        const changed = Buffer.from(ciphertext, "base64");
        changed[0] ^= 1;

        expect(() =>
            service.decrypt([iv, tag, changed.toString("base64")].join(":")),
        ).toThrow(/unable to authenticate data/);
    });

    it("rejects a value encrypted with another key", async () => {
        const encrypted = (await initialized()).encrypt("value");
        const other = await initialized();

        expect(() => other.decrypt(encrypted)).toThrow(
            /unable to authenticate data/,
        );
    });
});
