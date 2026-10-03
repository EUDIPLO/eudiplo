/** The configuration fields the active-credential limit depends on. */
export interface ActiveCredentialPolicySettings {
    activeCredentials?: { enabled: boolean } | null;
    statusManagement?: boolean | null;
}

export const ACTIVE_CREDENTIALS_REQUIRE_STATUS_MANAGEMENT =
    "statusManagement must be enabled when activeCredentials is enabled.";

/**
 * Whether the active-credential limit is enabled without status management.
 * The limit revokes a subject's previous credentials, which needs status list
 * entries, so such a configuration cannot be enforced and is rejected when it
 * is created, imported or its policy is updated.
 */
export function activeCredentialsLackStatusManagement(
    settings: ActiveCredentialPolicySettings,
): boolean {
    return (
        settings.activeCredentials?.enabled === true &&
        !settings.statusManagement
    );
}
