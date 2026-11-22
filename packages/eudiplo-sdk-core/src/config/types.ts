import type { ClaimFieldFormat } from "./formats";

export type CredentialFormat = "dc+sd-jwt" | "mso_mdoc";

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array";

export type ClaimPathElement = string | number | null;

export interface FieldDisplay {
  locale: string;
  name: string;
  description?: string;
}

export interface ClaimFieldDefinition {
  path: ClaimPathElement[];
  type: FieldType;
  /** JSON Schema format of a `string` claim; mDOC issuance encodes dates as CBOR tags 1004 and 0. */
  format?: ClaimFieldFormat;
  defaultValue?: unknown;
  mandatory?: boolean;
  disclosable?: boolean;
  namespace?: string;
  display?: FieldDisplay[];
  constraints?: Record<string, unknown>;
  children?: ClaimFieldDefinition[];
}

export interface ClaimMetadata {
  path: ClaimPathElement[];
  mandatory?: boolean;
  display?: FieldDisplay[];
}

export interface JsonSchema {
  $schema?: string;
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}
