import type { z } from "zod";
import { PresentationRequestSchema } from "../../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";

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
];
