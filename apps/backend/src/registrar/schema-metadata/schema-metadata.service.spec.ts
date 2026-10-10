import {
    BadRequestException,
    InternalServerErrorException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schemaMetadataControllerGetLatestVersionInfo } from "../generated/index.js";
import { SchemaMetadataService } from "./schema-metadata.service.js";

vi.mock("../generated/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../generated/index.js")>()),
    schemaMetadataControllerGetLatestVersionInfo: vi.fn(),
}));

describe("SchemaMetadataService upstream errors", () => {
    let service: SchemaMetadataService;
    const failWith = (error: unknown) =>
        vi
            .mocked(schemaMetadataControllerGetLatestVersionInfo)
            .mockResolvedValue({ data: undefined, error } as any);

    beforeEach(() => {
        vi.mocked(schemaMetadataControllerGetLatestVersionInfo).mockReset();
        service = new SchemaMetadataService({
            getClient: vi.fn().mockResolvedValue({}),
        } as any);
    });

    it("passes on the registrar's message", async () => {
        failWith({ statusCode: 400, message: "Invalid schema" });

        await expect(service.getLatest("tenant", "id")).rejects.toThrow(
            new BadRequestException("Invalid schema"),
        );
    });

    it("caps long messages", async () => {
        failWith({ message: "x".repeat(10_000) });

        await expect(service.getLatest("tenant", "id")).rejects.toThrow(
            new InternalServerErrorException(`${"x".repeat(500)}…`),
        );
    });

    it("does not pass on a non-string error body", async () => {
        failWith({ error: { secret: "upstream body" } });

        await expect(service.getLatest("tenant", "id")).rejects.toThrow(
            new InternalServerErrorException("Unknown registrar error"),
        );
    });
});
