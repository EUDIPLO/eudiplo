import { NoSuchKey, NotFound, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { StoredObjectNotFoundError } from "../storage.types.js";
import { S3FileStorage } from "./s3.storage.js";

function storage(error: Error): S3FileStorage {
    const s3 = { send: () => Promise.reject(error) } as unknown as S3Client;
    return new S3FileStorage(s3, "bucket");
}

describe("S3FileStorage.getStream", () => {
    it.each([
        ["NoSuchKey", new NoSuchKey({ message: "gone", $metadata: {} })],
        ["NotFound", new NotFound({ message: "gone", $metadata: {} })],
    ])("reports %s as StoredObjectNotFoundError", async (_, error) => {
        await expect(
            storage(error).getStream("tenant/logo.png"),
        ).rejects.toBeInstanceOf(StoredObjectNotFoundError);
    });

    it.each(["NoSuchKey", "NotFound"])(
        "reports a plain error named %s as StoredObjectNotFoundError",
        async (name) => {
            const error = Object.assign(new Error("gone"), { name });

            await expect(
                storage(error).getStream("tenant/logo.png"),
            ).rejects.toBeInstanceOf(StoredObjectNotFoundError);
        },
    );

    it("passes on other errors", async () => {
        const denied = Object.assign(new Error("Access Denied"), {
            name: "AccessDenied",
        });

        await expect(storage(denied).getStream("tenant/logo.png")).rejects.toBe(
            denied,
        );
    });
});
