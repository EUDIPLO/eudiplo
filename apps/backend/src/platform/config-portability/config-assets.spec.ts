import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ConfigBundleService } from "./config-bundle.service.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe("configuration asset plans", () => {
    it.each(["upsert", "create"])(
        "compares actual stored content in %s mode",
        async (mode) => {
            const service = Object.create(ConfigBundleService.prototype) as any;
            service.files = {
                findOneBy: async ({ filename }: any) =>
                    filename === "new.png" ? null : { id: filename },
            };
            service.filesService = {
                getStream: async () => ({
                    stream: Readable.from([Buffer.from("stored")]),
                    contentType: "image/png",
                }),
            };
            const assets = ["same.png", "changed.png", "new.png"].map(
                (name) => ({
                    path: `images/${name}`,
                    sha256: hash(name === "same.png" ? "stored" : "new"),
                }),
            );
            const result = await service.planAssets("tenant", { assets }, mode);
            expect(result.map((asset: any) => asset.action)).toEqual([
                "unchanged",
                mode === "create" ? "skip" : "update",
                "create",
            ]);
            expect(result[0].currentHash).toBe(hash("stored"));
        },
    );
});
