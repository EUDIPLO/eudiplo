import { z } from "zod";

/** OID4VP authorization response body as sent by the wallet. */
export const AuthResponseSchema = z
    .object({
        // OID4VP 1.0 §8.1: every credential id maps to a non-empty array of
        // presentations. An empty array must not count as presented.
        vp_token: z.record(z.string(), z.array(z.string()).min(1)),
        state: z.string().optional(),
        iat: z.number().optional(),
        exp: z.number().optional(),
    })
    .strict();

export type AuthResponseData = z.infer<typeof AuthResponseSchema>;
