import { createZodDto } from "nestjs-zod";
import {
    CreateOidcClientSchema,
    UpdateOidcClientSchema,
    UpdateOidcClientSecretSchema,
} from "../schemas/oidc-client.schema.js";

export class CreateOidcClientDto extends createZodDto(CreateOidcClientSchema) {}

export class UpdateOidcClientDto extends createZodDto(UpdateOidcClientSchema) {}

export class UpdateOidcClientSecretDto extends createZodDto(
    UpdateOidcClientSecretSchema,
) {}
