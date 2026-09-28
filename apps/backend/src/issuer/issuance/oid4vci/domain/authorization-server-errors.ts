/**
 * Base class for authorization-server problems that surface while building
 * offers or issuer metadata. Inbound adapters map them to HTTP 400 with the
 * error message.
 */
export abstract class AuthorizationServerError extends Error {}

/** No enabled authorization server matches the request or configuration. */
export class AuthorizationServerNotConfigured extends AuthorizationServerError {
    constructor(message: string) {
        super(message);
        this.name = "AuthorizationServerNotConfigured";
    }
}

/** The metadata of an external authorization server could not be fetched. */
export class AuthorizationServerMetadataUnavailable extends AuthorizationServerError {
    constructor() {
        super("Failed to fetch authorization server metadata");
        this.name = "AuthorizationServerMetadataUnavailable";
    }
}

/** An external authorization server failed the OpenID Federation trust policy. */
export class AuthorizationServerNotTrusted extends AuthorizationServerError {
    constructor(reason: string | undefined) {
        super(
            `Authorization server is not trusted by OpenID Federation policy: ${reason}`,
        );
        this.name = "AuthorizationServerNotTrusted";
    }
}
