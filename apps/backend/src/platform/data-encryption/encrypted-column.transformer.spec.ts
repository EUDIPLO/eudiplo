import { beforeAll, describe, expect, it } from "vitest";
import { initializeTestEncryption } from "../../../test/persistence/test-encryption.js";
import {
    encryptedJsonPaths,
    mapJsonPath,
} from "./encrypted-column.transformer.js";

describe("mapJsonPath", () => {
    const upper = (value: string) => value.toUpperCase();

    it("maps strings at the path and copies the input", () => {
        const input = { auth: { config: { headerName: "h", value: "v" } } };

        expect(mapJsonPath(input, "auth.config.value", upper)).toEqual({
            auth: { config: { headerName: "h", value: "V" } },
        });
        expect(input.auth.config.value).toBe("v");
    });

    it("matches every array item with *", () => {
        const servers = [
            { id: "a" },
            { id: "b", upstream: { clientSecret: "s" } },
        ];

        expect(mapJsonPath(servers, "*.upstream.clientSecret", upper)).toEqual([
            { id: "a" },
            { id: "b", upstream: { clientSecret: "S" } },
        ]);
    });

    it("leaves values without the path or with non-string leaves alone", () => {
        expect(mapJsonPath({ type: "none" }, "config.value", upper)).toEqual({
            type: "none",
        });
        expect(
            mapJsonPath({ config: { value: 1 } }, "config.value", upper),
        ).toEqual({ config: { value: 1 } });
    });
});

describe("encryptedJsonPaths", () => {
    const transformer = encryptedJsonPaths("config.value");
    const auth = { type: "apiKey", config: { headerName: "h", value: "key" } };

    beforeAll(initializeTestEncryption);

    it("encrypts only the secret and decrypts it again", () => {
        const stored = transformer.to(auth);

        expect(stored.config.headerName).toBe("h");
        expect(stored.config.value).not.toBe("key");
        expect(auth.config.value).toBe("key");
        expect(transformer.from(stored)).toEqual(auth);
    });

    it("reads plaintext values written before encryption", () => {
        expect(transformer.from(auth)).toEqual(auth);
    });

    it("passes null through", () => {
        expect(transformer.to(null)).toBeNull();
        expect(transformer.from(null)).toBeNull();
    });
});
