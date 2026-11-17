import { clientEditorSchemaBundle } from "../auth/client/schemas/client-editor-schema.bundle.js";
import { tenantEditorSchemaBundle } from "../auth/tenant/schemas/tenant-editor-schema.bundle.js";
import { certEditorSchemaBundle } from "../crypto/key/schemas/cert-editor-schema.bundle.js";
import { keyChainEditorSchemaBundle } from "../crypto/key/schemas/key-chain-editor-schema.bundle.js";
import { kmsEditorSchemaBundle } from "../crypto/key/schemas/kms-editor-schema.bundle.js";
import { attributeProviderEditorSchemaBundle } from "../issuer/configuration/attribute-provider/schemas/attribute-provider-editor-schema.bundle.js";
import { credentialEditorSchemaBundle } from "../issuer/configuration/credentials/schemas/credential-editor-schema.bundle.js";
import { issuanceEditorSchemaBundle } from "../issuer/configuration/issuance/schemas/issuance-editor-schema.bundle.js";
import { webhookEndpointEditorSchemaBundle } from "../issuer/configuration/webhook-endpoint/schemas/webhook-endpoint-editor-schema.bundle.js";
import { statusListEditorSchemaBundle } from "../issuer/status-list/dto/status-list-editor-schema.bundle.js";
import { trustListEditorSchemaBundle } from "../issuer/trust-list/schemas/trust-list-editor-schema.bundle.js";
import type { EditorSchemaBundle } from "../shared/common/zod/editor-schema.js";
import { federationTrustAnchorEditorSchemaBundle } from "../trust/federation-trust-anchor/schemas/federation-trust-anchor-editor-schema.bundle.js";
import { presentationEditorSchemaBundle } from "../verifier/presentations/schemas/presentation-editor-schema.bundle.js";
import { webhookEditorSchemaBundle } from "../webhook/webhook-editor-schema.bundle.js";

export const editorSchemaBundles: readonly EditorSchemaBundle[] = [
    clientEditorSchemaBundle,
    tenantEditorSchemaBundle,
    attributeProviderEditorSchemaBundle,
    webhookEndpointEditorSchemaBundle,
    keyChainEditorSchemaBundle,
    kmsEditorSchemaBundle,
    certEditorSchemaBundle,
    statusListEditorSchemaBundle,
    issuanceEditorSchemaBundle,
    credentialEditorSchemaBundle,
    presentationEditorSchemaBundle,
    trustListEditorSchemaBundle,
    federationTrustAnchorEditorSchemaBundle,
    webhookEditorSchemaBundle,
];
