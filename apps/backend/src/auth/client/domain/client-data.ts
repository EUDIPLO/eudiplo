import { ConflictError } from "../../../shared/domain/conflict-error.js";
import { NotSupportedError } from "../../../shared/domain/not-supported-error.js";
import type { Role } from "../../roles/role.enum.js";

export interface ClientData {
    clientId: string;
    tenantId?: string | null;
    description?: string | null;
    roles: Role[];
    allowedPresentationConfigs?: string[] | null;
    allowedIssuanceConfigs?: string[] | null;
    /**
     * When the client was created or got its current secret; its tokens
     * must name this instant. Only `getClientById` and
     * `validateClientCredentials` set it; it is not part of the client API.
     */
    tokensValidAfter?: Date | null;
}

export interface CreatedClient extends ClientData {
    clientSecret?: string;
}

/** A client ID is already used by a client of this or another tenant. */
export class ClientIdTaken extends ConflictError {
    constructor(clientId: string) {
        super(`Client ID '${clientId}' is already in use`);
    }
}

/** With `OIDC_PROVIDER=generic`, the identity provider manages the clients. */
export class ClientsManagedByIdentityProvider extends NotSupportedError {
    static readonly MESSAGE =
        "Clients are managed in the identity provider (OIDC_PROVIDER=generic).";

    constructor() {
        super(ClientsManagedByIdentityProvider.MESSAGE);
        this.name = "ClientsManagedByIdentityProvider";
    }
}
