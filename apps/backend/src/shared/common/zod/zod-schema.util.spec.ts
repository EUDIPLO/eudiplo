import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createConfigBodyPipe } from "./zod-schema.util.js";

const schema = z
    .object({
        id: z.string(),
        description: z.string().optional(),
        lifetime: z.number().min(1).optional(),
        label: z.string().nullable().optional(),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.id === "refined") {
            context.addIssue({ code: "custom", message: "refined" });
        }
    });

const readOnly = ["tenantId", "createdAt"];

function run(pipe: PipeTransform, body: unknown) {
    return pipe.transform(body, { type: "body" });
}

describe("createConfigBodyPipe", () => {
    const create = createConfigBodyPipe(schema, { readOnly });
    const partial = createConfigBodyPipe(schema, { readOnly, partial: true });

    it("rejects unknown fields with the validation error format", async () => {
        const error = await run(create, { id: "a", descripton: "typo" }).catch(
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
            message: "Validation failed",
            errors: [expect.objectContaining({ code: "unrecognized_keys" })],
        });
    });

    it("drops the read-only fields of a GET response and passes the body on as sent", async () => {
        await expect(
            run(create, {
                id: "a",
                lifetime: 5,
                tenantId: "t",
                createdAt: "2026-10-07",
            }),
        ).resolves.toEqual({ id: "a", lifetime: 5 });
    });

    it("treats null like a missing optional field on create, but keeps null where it is allowed", async () => {
        await expect(
            run(create, { id: "a", lifetime: null, label: null }),
        ).resolves.toEqual({ id: "a", label: null });
        await expect(run(create, { id: null })).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it("applies object refinements on create", async () => {
        await expect(run(create, { id: "refined" })).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it("accepts partial updates, keeps null to clear optional fields and still rejects unknown fields", async () => {
        await expect(run(partial, { lifetime: 2 })).resolves.toEqual({
            lifetime: 2,
        });
        await expect(run(partial, { lifetime: null })).resolves.toEqual({
            lifetime: null,
        });
        await expect(run(partial, { id: null })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(run(partial, { lifetme: 2 })).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});
