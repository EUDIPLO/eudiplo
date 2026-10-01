import {
        ClaimsWebhookRequest,
        hasCredentials,
        hasIdentity,
        NotificationWebhookRequest,
        validateClaimsWebhookRequest,
        validateNotificationWebhookRequest,
} from "./schemas";
import {
        ClaimsWebhookResponse,
        createClaimsResponse,
        createDeferredResponse,
        createNotificationSuccess,
} from "./types";

/**
 * Validates API key authentication.
 */
function validateApiKey(request: Request, expectedKey: string): boolean {
    return request.headers.get("x-api-key") === expectedKey;
}

/**
 * Parse JSON request body with error handling.
 */
async function parseJsonBody<T>(request: Request): Promise<T | null> {
    try {
        return (await request.json()) as T;
    } catch {
        return null;
    }
}

/**
 * Handle notification webhook.
 * Called when wallet notifies about credential status (accepted, failed, deleted).
 */
function handleNotification(data: NotificationWebhookRequest): Response {
    console.log("Received notification webhook:");
    console.log(`  Session: ${data.session}`);
    console.log(`  Notification ID: ${data.notification.id}`);
    console.log(`  Event: ${data.notification.event}`);
    console.log(
        `  Credential Config: ${data.notification.credentialConfigurationId}`,
    );

    const response = createNotificationSuccess();
    console.log("Outgoing notification response:", JSON.stringify(response, null, 2));
    return Response.json(response, { status: 200 });
}

/**
 * Sample values for claims the presented credential cannot provide, per
 * credential configuration. Presented values take precedence.
 */
function sampleClaims(credentialConfigurationId: string): Record<string, unknown> {
    const today = new Date();
    const isoDate = (date: Date) => date.toISOString().slice(0, 10);
    const inYears = (years: number) => {
        const date = new Date(today);
        date.setFullYear(date.getFullYear() + years);
        return date;
    };

    switch (credentialConfigurationId) {
        case "mdl":
            return {
                birth_date: "1964-08-12",
                age_over_18: true,
                document_number: "Z021AB37X13",
                issue_date: isoDate(today),
                expiry_date: isoDate(inYears(15)),
                issuing_country: "DE",
                issuing_authority: "Bundesrepublik Deutschland",
                un_distinguishing_sign: "D",
                driving_privileges: [
                    {
                        vehicle_category_code: "B",
                        issue_date: isoDate(today),
                        expiry_date: isoDate(inYears(15)),
                        codes: [{ code: "B96", value: "4250", sign: "<=" }],
                    },
                ],
            };
        default:
            return {};
    }
}

/**
 * Handle claims webhook for flows with a presentation.
 * Called after the wallet presented credentials, e.g. to an OID4VP
 * authorization server, to derive claims for the new credential.
 */
function handleClaimsWithPresentation(data: ClaimsWebhookRequest): Response {
    console.log("Received claims webhook (presentation flow):");
    console.log(`  Session: ${data.session}`);
    console.log(`  Credential Config: ${data.credential_configuration_id}`);

    if (!hasCredentials(data)) {
        return Response.json(
            { error: "No credentials presented" },
            { status: 400 },
        );
    }

    // Example: Take the disclosed values of the first presented credential
    const presentedCredential = data.credentials[0];
    const disclosedValues = presentedCredential.values[0] ?? {};
    console.log(
        `  Presented credential '${presentedCredential.id}':`,
        JSON.stringify(disclosedValues, null, 2),
    );

    const claims: Record<string, unknown> = {};
    if (disclosedValues.given_name) {
        claims.given_name = disclosedValues.given_name;
    }
    if (disclosedValues.family_name) {
        claims.family_name = disclosedValues.family_name;
    }
    // SD-JWT PID uses `birthdate`, mdoc credentials use `birth_date`
    const birthDate = disclosedValues.birth_date ?? disclosedValues.birthdate;
    if (birthDate) {
        claims.birth_date = birthDate;
    }

    // Type-safe access with optional chaining
    const address = disclosedValues.address as
        | { locality?: string }
        | undefined;
    // Claim schemas reject unknown claims, and the mDL has no `town`
    if (address?.locality && data.credential_configuration_id !== "mdl") {
        claims.town = `You live in ${address.locality}`;
    }

    if (Object.keys(claims).length === 0) {
        return Response.json(
            { error: "No usable claims in presented credential" },
            { status: 400 },
        );
    }

    // Return claims for the requested credential configuration, filling in
    // sample values for mandatory claims the presentation did not provide
    const response: ClaimsWebhookResponse = createClaimsResponse(
        data.credential_configuration_id,
        { ...sampleClaims(data.credential_configuration_id), ...claims },
    );

    console.log("Outgoing claims response:", JSON.stringify(response, null, 2));
    return Response.json(response, { status: 200 });
}

/**
 * Handle unified claims webhook.
 * Supports both:
 * - Flows with a presentation (when credentials are present)
 * - Authorization code flow with external AS (when only identity is present)
 */
function handleUnifiedClaims(data: ClaimsWebhookRequest): Response {
    console.log("Incoming claims request:", JSON.stringify(data, null, 2));

    console.log("Received unified claims webhook:");
    console.log(`  Session: ${data.session}`);
    console.log(`  Credential Config: ${data.credential_configuration_id}`);

    // Case 1: Presentation flow - credentials are present. Checked first,
    // because an OID4VP authorization server sends identity as well.
    if (hasCredentials(data)) {
        return handleClaimsWithPresentation(data);
    }

    // Case 2: External AS flow - identity information is present
    if (hasIdentity(data)) {
        console.log(`  Identity from external AS:`);
        console.log(`    Issuer: ${data.identity.iss}`);
        console.log(`    Subject: ${data.identity.sub}`);
        console.log(
            `    Token Claims:`,
            JSON.stringify(data.identity.token_claims, null, 2),
        );

        // Map external AS claims to credential claims
        const claims: Record<string, unknown> = {};

        if (data.identity.token_claims.given_name) {
            claims.given_name = data.identity.token_claims.given_name;
        }
        if (data.identity.token_claims.family_name) {
            claims.family_name = data.identity.token_claims.family_name;
        }

        const response: ClaimsWebhookResponse = createClaimsResponse(
            data.credential_configuration_id,
            { ...sampleClaims(data.credential_configuration_id), ...claims },
        );
        console.log("Outgoing unified claims response:", JSON.stringify(response, null, 2));
        return Response.json(response, { status: 200 });
    }

    // Case 3: No identity or credentials - return error or default claims
    console.log("  No identity or credentials present");
    return Response.json(
        { error: "Missing identity or credentials in request" },
        { status: 400 },
    );
}

/**
 * Handle deferred issuance claims webhook.
 * Returns deferred response for async claims resolution.
 */
function handleDeferredClaims(): Response {
    console.log(
        "Returning deferred response (claims will be resolved asynchronously)",
    );

    const response = createDeferredResponse(10); // Poll every 10 seconds
    console.log("Outgoing deferred response:", JSON.stringify(response, null, 2));
    return Response.json(response, { status: 200 });
}

async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
    }

    // Parse JSON body for all POST endpoints
    const body = await parseJsonBody<unknown>(request);
    if (body === null) {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    switch (url.pathname) {
        // ============================================================
        // Notification Endpoint
        // ============================================================
        case "/notify": {
            const validation = validateNotificationWebhookRequest(body);
            if (!validation.success) {
                console.error("Notification webhook validation failed:");
                console.error(`  Error: ${validation.error}`);
                console.error(
                    `  Details:`,
                    JSON.stringify(validation.details, null, 2),
                );
                return Response.json(
                    {
                        error: "Invalid notification webhook payload",
                        message: validation.error,
                        details: validation.details,
                    },
                    { status: 400 },
                );
            }
            return handleNotification(validation.data);
        }

        // ============================================================
        // Claims Endpoint (Unified - handles both internal and external AS flows)
        // ============================================================
        case "/claims": {
            const validation = validateClaimsWebhookRequest(body);
            if (!validation.success) {
                console.error("Claims webhook validation failed:");
                console.error(`  Error: ${validation.error}`);
                console.error(
                    `  Details:`,
                    JSON.stringify(validation.details, null, 2),
                );
                return Response.json(
                    {
                        error: "Invalid claims webhook payload",
                        message: validation.error,
                        details: validation.details,
                    },
                    { status: 400 },
                );
            }
            return handleUnifiedClaims(validation.data);
        }

        // ============================================================
        // Deferred Claims Endpoint (for async workflows)
        // ============================================================
        case "/deferred-claims": {
            return handleDeferredClaims();
        }

        // ============================================================
        // Authenticated Endpoint Example
        // ============================================================
        case "/consume": {
            const expectedApiKey = "foo-bar"; // Move to env/config in production
            if (!validateApiKey(request, expectedApiKey)) {
                return new Response("Unauthorized", { status: 401 });
            }
            console.log("Received authenticated webhook:");
            console.log(JSON.stringify(body, null, 2));
            return Response.json({ status: "ok" }, { status: 200 });
        }

        default:
            return new Response("Not found", { status: 404 });
    }
}

export default {
    fetch: handleRequest,
};
