/**
 * Migration index - exports all migration classes for TypeORM.
 * Import migrations directly to avoid ESM/CJS compatibility issues
 * with dynamic file loading during tests.
 */
export { BaselineMigration1740000000000 } from "./1740000000000-BaselineMigration.js";
export { AddKmsProvider1740500000000 } from "./1740500000000-AddKmsProvider.js";
export { AddSigningKeyIdToIssuanceConfig1741000000000 } from "./1741000000000-AddSigningKeyIdToIssuanceConfig.js";
export { AddPreferredAuthServerToIssuanceConfig1741500000000 } from "./1741500000000-AddPreferredAuthServerToIssuanceConfig.js";
export { AddExternalKeyId1742000000000 } from "./1742000000000-AddExternalKeyId.js";
export { AddKeyUsageEntity1743000000000 } from "./1743000000000-AddKeyUsageEntity.js";
export { AddKeyRotation1744000000000 } from "./1744000000000-AddKeyRotation.js";
export { RenameSigningToAttestation1745000000000 } from "./1745000000000-RenameSigningToAttestation.js";
export { FlattenKeyUsageType1746000000000 } from "./1746000000000-FlattenKeyUsageType.js";
export { MigrateKeysToKeyChain1747000000000 } from "./1747000000000-MigrateKeysToKeyChain.js";
export { ExtractAttributeProviderAndWebhookEndpoint1748000000000 } from "./1748000000000-ExtractAttributeProviderAndWebhookEndpoint.js";
export { AddSessionLogEntry1749000000000 } from "./1749000000000-AddSessionLogEntry.js";
export { AddSessionErrorReason1750000000000 } from "./1750000000000-AddSessionErrorReason.js";
export { AddDirectPostSecurityFields1751000000000 } from "./1751000000000-AddDirectPostSecurityFields.js";
export { AddRefreshTokenToSession1752000000000 } from "./1752000000000-AddRefreshTokenToSession.js";
export { AddCredentialResponseEncryptionToIssuanceConfig1753000000000 } from "./1753000000000-AddCredentialResponseEncryptionToIssuanceConfig.js";
export { AddCredentialRequestEncryptionToIssuanceConfig1753100000000 } from "./1753100000000-AddCredentialRequestEncryptionToIssuanceConfig.js";
export { AddRefreshTokenToChainedAsSession1754000000000 } from "./1754000000000-AddRefreshTokenToChainedAsSession.js";
export { AddRegistrationCertificateDefaultsToRegistrarConfig1755000000000 } from "./1755000000000-AddRegistrationCertificateDefaultsToRegistrarConfig.js";
export { AddRegistrationCertCacheToPresentationConfig1756000000000 } from "./1756000000000-AddRegistrationCertCacheToPresentationConfig.js";
export { AddTxCodeAttemptTracking1757000000000 } from "./1757000000000-AddTxCodeAttemptTracking.js";
export { AddSessionSingleUseTracking1760000000000 } from "./1760000000000-AddSessionSingleUseTracking.js";
export { AddSchemaMetaToCredentialConfig1761000000000 } from "./1761000000000-AddSchemaMetaToCredentialConfig.js";
export { AddTenantActionLog1762000000000 } from "./1762000000000-AddTenantActionLog.js";
export { AddFederationToIssuanceConfig1763000000000 } from "./1763000000000-AddFederationToIssuanceConfig.js";
export { AddKmsExternalKeyIdCheck1764000000000 } from "./1764000000000-AddKmsExternalKeyIdCheck.js";
export { RenameKeyChainActiveKeyToActiveJwk1765000000000 } from "./1765000000000-RenameKeyChainActiveKeyToActiveJwk.js";
export { AddAuthorizationServersToIssuanceConfig1766000000000 } from "./1766000000000-AddAuthorizationServersToIssuanceConfig.js";
export { AddIssuerRegistrationCertificateToIssuanceConfig1767000000000 } from "./1767000000000-AddIssuerRegistrationCertificateToIssuanceConfig.js";
export { RemoveRefreshTokenFromIssuanceConfig1768000000000 } from "./1768000000000-RemoveRefreshTokenFromIssuanceConfig.js";
export { RemovePreferredAuthServerFromIssuanceConfig1769000000000 } from "./1769000000000-RemovePreferredAuthServerFromIssuanceConfig.js";
export { AddDcApiProtocolToSession1770000000000 } from "./1770000000000-AddDcApiProtocolToSession.js";
export { AddCwtCacheToStatusList1771000000000 } from "./1771000000000-AddCwtCacheToStatusList.js";
export { AddVerifierSkewSeconds1772000000000 } from "./1772000000000-AddVerifierSkewSeconds.js";
export { AddPresentationStatusCheckMode1773000000000 } from "./1773000000000-AddPresentationStatusCheckMode.js";
export { AddReaderAuthToPresentationConfig1774000000000 } from "./1774000000000-AddReaderAuthToPresentationConfig.js";
export { AddRootExternalKeyIdToKeyChain1774000000000 } from "./1774000000000-AddRootExternalKeyIdToKeyChain.js";
export { AddNotificationEndpointEnabledToIssuanceConfig1775000000000 } from "./1775000000000-AddNotificationEndpointEnabledToIssuanceConfig.js";
export { AddStatusListVersionAndUniqueConstraint1776000000000 } from "./1776000000000-AddStatusListVersionAndUniqueConstraint.js";
export { AddConfigResourceMetadata1777000000000 } from "./1777000000000-AddConfigResourceMetadata.js";
export { AddMissingSessionColumns1778000000000 } from "./1778000000000-AddMissingSessionColumns.js";
export { AddActiveCredentialSlot1779000000000 } from "./1779000000000-AddActiveCredentialSlot.js";
export { AddOutcomeToSession1779000000000 } from "./1779000000000-AddOutcomeToSession.js";
export { AddIssuanceSetIdToDeferredTransaction1780000000000 } from "./1780000000000-AddIssuanceSetIdToDeferredTransaction.js";

export { AddConfigImportRun1781000000000 } from "./1781000000000-AddConfigImportRun.js";
export { AddOauthBindingsToSession1782000000000 } from "./1782000000000-AddOauthBindingsToSession.js";
export { AddDpopProofJti1783000000000 } from "./1783000000000-AddDpopProofJti.js";
