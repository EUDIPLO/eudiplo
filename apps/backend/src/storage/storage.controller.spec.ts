import { Readable } from "node:stream";
import {
    InternalServerErrorException,
    NotFoundException,
    StreamableFile,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { FilesService } from "./files.service.js";
import { StorageController } from "./storage.controller.js";

function createController(getStream: FilesService["getStream"]) {
    return new StorageController({ getStream } as FilesService);
}

describe("StorageController.download", () => {
    it("streams the file as an attachment", async () => {
        const controller = createController(() =>
            Promise.resolve({
                stream: Readable.from(["png"]),
                contentType: "image/png",
                size: 3,
            }),
        );

        const file = await controller.download("tenant/logo.png");

        expect(file).toBeInstanceOf(StreamableFile);
        expect(file.getHeaders()).toMatchObject({
            type: "image/png",
            length: 3,
            disposition: "attachment",
        });
    });

    it("answers a missing file with 404", async () => {
        const controller = createController(() =>
            Promise.reject(new NotFoundException()),
        );

        await expect(controller.download("tenant/missing.png")).rejects.toThrow(
            NotFoundException,
        );
    });

    it("does not turn a storage outage into 404", async () => {
        const outage = new InternalServerErrorException(
            "File could not be read",
        );
        const controller = createController(() => Promise.reject(outage));

        await expect(controller.download("tenant/logo.png")).rejects.toBe(
            outage,
        );
    });
});
