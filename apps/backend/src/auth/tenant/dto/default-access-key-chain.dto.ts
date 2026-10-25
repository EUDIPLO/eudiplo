import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const UpdateDefaultAccessKeyChainSchema = z
    .strictObject({
        defaultAccessKeyChainId: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .describe(
                "ID of an access key chain of the tenant, or null to let EUDIPLO pick one by rule.",
            ),
    })
    .describe("The tenant's default access key chain.");

export class UpdateDefaultAccessKeyChainDto extends createZodDto(
    UpdateDefaultAccessKeyChainSchema,
) {}

export class DefaultAccessKeyChainDto {
    @ApiPropertyOptional({
        description:
            "Access key chain the tenant names as its default. Absent when EUDIPLO picks one by rule.",
    })
    defaultAccessKeyChainId?: string;

    @ApiPropertyOptional({
        description:
            "Access key chain that requests use where no configuration names one: defaultAccessKeyChainId, else the one picked by rule. Absent when the tenant has no access key chain or names one that no longer exists.",
    })
    keyChainId?: string;
}
