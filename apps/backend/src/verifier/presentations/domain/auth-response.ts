import { z } from "zod";

/** OID4VP authorization response body as sent by the wallet. */
export const AuthResponseSchema = z
    .object({
        vp_token: z.record(z.string(), z.array(z.string())),
        state: z.string().optional(),
        iat: z.number().optional(),
        exp: z.number().optional(),
    })
    .strict();

export type AuthResponseData = z.infer<typeof AuthResponseSchema>;
