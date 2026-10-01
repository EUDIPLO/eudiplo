import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaMetadataSubmissionService } from "./schema-metadata-submission.service.js";

describe("SchemaMetadataSubmissionService remote files", () => {
    const outbound = { getFollowingRedirects: vi.fn() };
    const service = new SchemaMetadataSubmissionService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        outbound as never,
    );
    const fetchRemoteFile = (url: string) =>
        (
            service as unknown as {
                fetchRemoteFile(
                    sourceUrl: string,
                    fallbackFileName: string,
                    label: string,
                ): Promise<Blob | File>;
            }
        ).fetchRemoteFile(url, "rulebook-1.0.0.md", "rulebook");

    beforeEach(() => {
        outbound.getFollowingRedirects.mockReset();
    });

    it("downloads through the outbound URL policy with bounded limits", async () => {
        outbound.getFollowingRedirects.mockResolvedValue({
            status: 200,
            url: "https://rules.example/v1/rulebook.md",
            contentType: "text/markdown",
            body: "# Rules",
            bytes: Buffer.from("# Rules"),
        });

        const file = (await fetchRemoteFile(
            "https://rules.example/v1/rulebook.md",
        )) as File;

        expect(outbound.getFollowingRedirects).toHaveBeenCalledWith(
            "https://rules.example/v1/rulebook.md",
            { timeoutMs: 10_000, maxBytes: 5 * 1024 * 1024, maxRedirects: 3 },
        );
        expect(file.name).toBe("rulebook.md");
        expect(file.type).toBe("text/markdown");
        expect(await file.text()).toBe("# Rules");
    });

    it("rejects targets blocked by the policy", async () => {
        outbound.getFollowingRedirects.mockRejectedValue(
            new BadRequestException(
                "Outbound URL target resolves to a private or loopback IP",
            ),
        );

        await expect(
            fetchRemoteFile("https://internal.example/rulebook.md"),
        ).rejects.toThrow(
            "Failed to fetch rulebook (https://internal.example/rulebook.md): Outbound URL target resolves to a private or loopback IP",
        );
    });

    it("rejects non-success responses", async () => {
        outbound.getFollowingRedirects.mockResolvedValue({
            status: 404,
            url: "https://rules.example/missing.md",
            body: "",
            bytes: Buffer.alloc(0),
        });

        await expect(
            fetchRemoteFile("https://rules.example/missing.md"),
        ).rejects.toThrow("HTTP 404");
    });
});
