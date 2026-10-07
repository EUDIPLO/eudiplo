import { join } from "node:path/posix";
import Joi from "joi";

export const STORAGE_VALIDATION_SCHEMA = Joi.object({
    STORAGE_DRIVER: Joi.string()
        .valid("local", "s3")
        .default("local")
        .description("The storage driver to use")
        .meta({ group: "storage", order: 10 }),
    LOCAL_STORAGE_DIR: Joi.string()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "local",
            then: Joi.string().default((parent) =>
                join(parent.FOLDER, "uploads"),
            ),
        })
        .description("The directory to store files in when using local storage")
        .meta({
            group: "storage",
            order: 20,
            defaultText: "`<FOLDER>/uploads`",
        }),
    S3_REGION: Joi.string()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "s3",
            then: Joi.required(),
        })
        .description("The AWS region for the S3 bucket")
        .meta({ group: "storage", order: 30 }),
    S3_BUCKET: Joi.string()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "s3",
            then: Joi.required(),
        })
        .description("The name of the S3 bucket")
        .meta({ group: "storage", order: 40 }),
    S3_ACCESS_KEY_ID: Joi.string()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "s3",
            then: Joi.optional(),
        })
        .description(
            "The access key ID for the S3 bucket. Optional when using IRSA or instance profile credentials.",
        )
        .meta({ group: "storage", order: 50 }),
    S3_SECRET_ACCESS_KEY: Joi.string()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "s3",
            then: Joi.optional(),
        })
        .description(
            "The secret access key for the S3 bucket. Optional when using IRSA or instance profile credentials.",
        )
        .meta({ group: "storage", order: 60 }),
    S3_ENDPOINT: Joi.string()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "s3",
            then: Joi.optional(),
        })
        .description(
            "The endpoint URL for the S3 service (for S3-compatible services)",
        )
        .meta({ group: "storage", order: 70 }),
    S3_FORCE_PATH_STYLE: Joi.boolean()
        .when(Joi.ref("STORAGE_DRIVER"), {
            is: "s3",
            then: Joi.boolean().default(false),
        })
        .description("Whether to force path-style URLs for S3")
        .meta({ group: "storage", order: 80 }),
});
