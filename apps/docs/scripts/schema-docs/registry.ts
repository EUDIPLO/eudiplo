import type { z } from "zod";
import { CreateAttributeProviderSchema } from "../../../backend/src/issuer/configuration/attribute-provider/schemas/attribute-provider.schema.js";
import { CredentialConfigCreateSchema } from "../../../backend/src/issuer/configuration/credentials/schemas/credential-config.schema.js";
import { OfferRequestSchema } from "../../../backend/src/issuer/issuance/oid4vci/dto/offer-request.schema.js";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { PresentationConfigCreateSchema } from "../../../backend/src/verifier/presentations/schemas/presentation-config.schema.js";
import { TrustListCreateSchema } from "../../../backend/src/issuer/trust-list/schemas/trust-list.schema.js";

export interface SchemaDoc {
    /** File name of the model (`docs/_generated/schemas/<name>.json`) and the `name` prop of `<SchemaReference>`. */
    name: string;
    /** The Zod schema the backend validates with; the docs are generated from it. */
    schema: z.ZodType;
}

/**
 * Zod schemas rendered in the docs. Add an entry here, run
 * `pnpm --filter @eudiplo/docs run prebuild`, then use
 * `<SchemaReference name="<name>" mode="table" />` (field table) or
 * `mode="body"` (annotated JSONC sample) on a page.
 */
export const schemaDocs: SchemaDoc[] = [
    { name: "presentation-request", schema: PresentationRequestSchema },
    { name: "credential-configuration", schema: CredentialConfigCreateSchema },
    // One entry of `fields[]`; recursive (`children`), so it gets its own table.
    { name: "credential-field", schema: CredentialConfigCreateSchema.shape.fields.element },
    { name: "offer-request", schema: OfferRequestSchema },
    { name: "attribute-provider", schema: CreateAttributeProviderSchema },
    { name: "presentation-configuration", schema: PresentationConfigCreateSchema },
    { name: "trust-list", schema: TrustListCreateSchema },
];
