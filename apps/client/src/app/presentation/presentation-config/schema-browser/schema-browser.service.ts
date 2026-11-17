import { Injectable } from '@angular/core';
import {
  presentationManagementControllerResolveSchemaMetadata,
  type ResolvedSchemaMetadataResponseDto,
} from '@eudiplo/sdk-core';

export type ResolvedSchema = ResolvedSchemaMetadataResponseDto;

export interface SchemaImportResult {
  dcqlQuery: object;
  suggestedPresentationId?: string;
  suggestedDescription?: string;
}

@Injectable()
export class SchemaBrowserService {
  async fetchSchema(schemaMetadataUrl: string): Promise<ResolvedSchema> {
    const response = await presentationManagementControllerResolveSchemaMetadata({
      body: { schemaMetadataUrl },
    });

    return response.data as ResolvedSchema;
  }

  generateImportResult(resolved: ResolvedSchema, selectedFormats: string[]): SchemaImportResult {
    const allCredentials =
      (resolved.schema.dcqlQuery as { credentials?: Record<string, unknown>[] } | undefined)
        ?.credentials ?? [];
    const selected = new Set(selectedFormats);
    const credentials = allCredentials.filter((credential) => {
      const format = credential['format'];
      return typeof format === 'string' && selected.has(format);
    });

    const dcqlQuery = { credentials };
    const suggestedPresentationId = this.derivePresentationId(resolved);
    const suggestedDescription = this.deriveDescription(resolved);

    return {
      dcqlQuery,
      suggestedPresentationId,
      suggestedDescription,
    };
  }

  private sanitizeId(value: string): string {
    return (
      (value || 'schema')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_/, '')
        .replace(/_$/, '')
        .slice(0, 50) || 'schema'
    );
  }

  private derivePresentationId(resolved: ResolvedSchema): string {
    const source = resolved.schema.name || resolved.schema.id;
    const version = resolved.schema.version
      ? `_v${resolved.schema.version.replace(/[^0-9a-zA-Z]+/g, '_')}`
      : '';
    return `${this.sanitizeId(source)}${version}`;
  }

  private deriveDescription(resolved: ResolvedSchema): string {
    if (resolved.schema.description) {
      return resolved.schema.description;
    }

    const label = resolved.schema.name || resolved.schema.id;
    const versionSuffix = resolved.schema.version ? ` (v${resolved.schema.version})` : '';
    return `Imported from schema ${label}${versionSuffix}`;
  }
}
