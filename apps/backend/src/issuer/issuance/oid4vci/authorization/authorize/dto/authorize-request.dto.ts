import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { SessionAuthorization } from "../../../../../../session/domain/session-data.js";

const AuthorizeQueriesSchema = z
    .object({
        issuer_state: z.string().optional(),
        response_type: z.string().optional(),
        client_id: z.string().optional(),
        redirect_uri: z.string().optional(),
        resource: z.string().optional(),
        scope: z.string().optional(),
        code_challenge: z.string().optional(),
        code_challenge_method: z.string().optional(),
        dpop_jkt: z.string().optional(),
        request_uri: z.string().optional(),
        auth_session: z.string().optional(),
        state: z.string().optional(),
        authorization_details: z
            .union([z.string(), z.array(z.unknown())])
            .optional(),
    })
    .strict();

export class AuthorizeQueries
    extends createZodDto(AuthorizeQueriesSchema)
    implements SessionAuthorization
{
    issuer_state?: string;
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    resource?: string;
    scope?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    dpop_jkt?: string;
    request_uri?: string;
    auth_session?: string;
    state?: string;
    /**
     * RFC 9396 authorization details. When passed via
     * application/x-www-form-urlencoded (PAR) the value is a JSON string; when
     * passed inside a signed request object it can already be an array.
     */
    authorization_details?: string | any[];
}
