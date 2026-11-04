import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileStorage } from "./adapters/local.storage.js";
import { FilesService } from "./files.service.js";
import {
    type FileStorage,
    StoredObjectNotFoundError,
} from "./storage.types.js";

function createService(storage: FileStorage): FilesService {
    const orchestrator = { register: () => undefined };
    return new FilesService(
        storage,
        {} as never,
        {} as never,
        {} as never,
        orchestrator as never,
    );
}

describe("FilesService.getStream", () => {
    let baseDir: string;
    let service: FilesService;

    beforeEach(() => {
        baseDir = mkdtempSync(join(tmpdir(), "eudiplo-files-"));
        service = createService(new LocalFileStorage(baseDir));
    });

    afterEach(() => {
        rmSync(baseDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("returns the stored file", async () => {
        await new LocalFileStorage(baseDir).put(
            "tenant/logo.png",
            Buffer.from("png"),
            { contentType: "image/png" },
        );

        const stored = await service.getStream("tenant/logo.png");

        expect(stored.contentType).toBe("image/png");
        expect(stored.size).toBe(3);
        expect((await stored.stream.toArray()).join("")).toBe("png");
    });

    it("answers a missing file with NotFoundException", async () => {
        await expect(service.getStream("tenant/missing.png")).rejects.toThrow(
            NotFoundException,
        );
    });

    it("answers a key outside the storage folder with NotFoundException", async () => {
        await expect(service.getStream("../secret.txt")).rejects.toThrow(
            NotFoundException,
        );
    });

    it("answers a key below a file with NotFoundException", async () => {
        await new LocalFileStorage(baseDir).put(
            "tenant/logo.png",
            Buffer.from("png"),
        );

        await expect(service.getStream("tenant/logo.png/x")).rejects.toThrow(
            NotFoundException,
        );
    });

    it("answers a key that names a folder with NotFoundException", async () => {
        await new LocalFileStorage(baseDir).put(
            "tenant/logo.png",
            Buffer.from("png"),
        );

        await expect(service.getStream("tenant")).rejects.toThrow(
            NotFoundException,
        );
    });

    it("answers an object the adapter reports missing with NotFoundException", async () => {
        const missing = createService({
            getStream: (key: string) =>
                Promise.reject(new StoredObjectNotFoundError(key)),
        } as unknown as FileStorage);

        await expect(missing.getStream("tenant/logo.png")).rejects.toThrow(
            NotFoundException,
        );
    });

    it("logs other storage errors and does not return their details", async () => {
        const error = vi
            .spyOn(Logger.prototype, "error")
            .mockImplementation(() => undefined);
        const outage = new Error("connect ECONNREFUSED s3.internal:9000");
        const failing = createService({
            getStream: () => Promise.reject(outage),
        } as unknown as FileStorage);

        const result = failing.getStream("tenant/logo.png");

        await expect(result).rejects.toThrow(InternalServerErrorException);
        await expect(result).rejects.toThrow("File could not be read");
        expect(error).toHaveBeenCalledWith(
            'Reading file "tenant/logo.png" from storage failed',
            outage.stack,
        );
    });
});
