import embeddedDisclosurePolicySchemaObj from '../../../../../schemas/EmbeddedDisclosurePolicy.schema.json';
import vctSchemaObj from '../../../../../schemas/VCT.schema.json';
import webhookSchemaObj from '../../../../../schemas/WebhookConfig.schema.json';
import credentialConfigSchemaObj from '../../../../../schemas/CredentialConfigCreate.schema.json';
import issuanceConfigSchemaObj from '../../../../../schemas/IssuanceConfig.schema.json';
import DCQLObj from '../../../../../schemas/DCQL.schema.json';
import presnetationConfigCreateSchemaObj from '../../../../../schemas/PresentationConfigCreateDto.schema.json';
import transactionDataSchemaObj from '../../../../../schemas/TransactionData.schema.json';
import kmsConfigSchemaObj from '../../../../../schemas/KmsConfigDto.schema.json';

// Create an array schema for TransactionData (URI-based matching allows arrays as root)
const transactionDataArraySchemaObj = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://raw.githubusercontent.com/EUDIPLO/eudiplo/refs/heads/main/schemas/TransactionDataArray.schema.json',
  title: 'TransactionDataArray',
  type: 'array',
  items: transactionDataSchemaObj,
};

export class SchemaValidation {
  constructor(private schema: any) {}

  getSchema() {
    return this.schema;
  }

  getSchemaUrl() {
    return this.schema['$id'];
  }

  /**
   * Get the fileMatch URI pattern for Monaco editor model.
   * This allows Monaco to auto-apply the schema without needing $schema in the content.
   * Uses format: a://b/{SchemaName}-{instanceId}-{version}.schema.json to match schemas.json fileMatch patterns.
   * The instanceId and version ensure each editor instance gets a unique model URI,
   * preventing Monaco from reusing cached models with stale values.
   */
  getFileMatchUri(instanceId?: number, version?: number): string {
    const schemaId = this.schema['$id'] || '';
    const fileName = schemaId.split('/').pop() || 'unknown.schema.json';
    // Include instanceId and version in the URI to ensure unique models
    const baseName = fileName.replace('.schema.json', '');
    const suffix = instanceId != null && version != null ? `-${instanceId}-${version}` : '';
    return `a://b/${baseName}${suffix}.schema.json`;
  }
}

export const vctSchema = new SchemaValidation(vctSchemaObj);
export const embeddedDisclosurePolicySchema = new SchemaValidation(
  embeddedDisclosurePolicySchemaObj
);
export const webhookSchema = new SchemaValidation(webhookSchemaObj);
export const credentialConfigSchema = new SchemaValidation(credentialConfigSchemaObj);
export const issuanceConfigSchema = new SchemaValidation(issuanceConfigSchemaObj);

export const presentationConfigSchema = new SchemaValidation(presnetationConfigCreateSchemaObj);

export const DCQLSchema = new SchemaValidation(DCQLObj);

export const transactionDataArraySchema = new SchemaValidation(transactionDataArraySchemaObj);

export const kmsConfigSchema = new SchemaValidation(kmsConfigSchemaObj);
