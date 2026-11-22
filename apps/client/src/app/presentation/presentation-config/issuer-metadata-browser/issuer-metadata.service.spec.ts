import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { schemaFormValidator } from '../../../utils/schema-form-validator';
import { DCQLSchema } from '../../../utils/schemas';
import { readSimpleDcql } from '../dcql-query-editor/simple-dcql';
import { IssuerMetadataService, NormalizedCredential } from './issuer-metadata.service';

describe('issuer imports for the presentation builder', () => {
  it('imports mDOC claims as DCQL paths that preserve the advertised namespace', () => {
    const service = new IssuerMetadataService(null as any, null as any);
    const credential: NormalizedCredential = {
      id: 'mdl',
      format: 'mso_mdoc',
      displayName: 'Driving licence',
      doctype: 'org.iso.18013.5.1.mDL',
      claims: [
        {
          path: ['org.iso.18013.5.1', 'family_name'],
          namespace: 'org.iso.18013.5.1',
          displayName: 'Family name',
          mandatory: false,
        },
      ],
    };
    const query = service.generateDcqlQuery([{ credential, selectedClaims: credential.claims }]);
    expect(new FormControl(query, [schemaFormValidator(DCQLSchema)]).valid).toBe(true);
    expect(readSimpleDcql(query)?.credentials[0]).toMatchObject({
      claims: [{ path: ['org.iso.18013.5.1', 'family_name'] }],
    });
  });

  it('asks for the array when a selected claim addresses every element of it', () => {
    const service = new IssuerMetadataService(null as any, null as any);
    const [credential] = service.normalizeCredentials({
      credential_issuer: 'https://issuer.example',
      credential_configurations_supported: {
        pid: {
          format: 'dc+sd-jwt',
          vct: 'urn:eudi:pid:de:1',
          credential_metadata: {
            claims: [
              { path: ['given_name'] },
              { path: ['nationalities'] },
              { path: ['nationalities', null] },
              { path: ['addresses', null, 'locality'] },
              { path: ['places', 0, 'city'] },
              { path: [null] },
            ],
          },
        },
      },
    } as any);
    // The catalog keeps the published paths: the query builder hints read them.
    expect(credential.claims.map((claim) => claim.path)).toContainEqual(['nationalities', null]);

    const query = service.generateDcqlQuery([{ credential, selectedClaims: credential.claims }]);
    expect(readSimpleDcql(query)?.credentials[0].claims?.map((claim) => claim.path)).toEqual([
      ['given_name'],
      ['nationalities'],
      ['addresses'],
      ['places', 0, 'city'],
    ]);
  });

  it('leaves the claims out when no selected claim has a path the query can ask for', () => {
    const service = new IssuerMetadataService(null as any, null as any);
    const credential: NormalizedCredential = {
      id: 'list',
      format: 'dc+sd-jwt',
      displayName: 'List',
      vct: 'urn:example:list',
      claims: [{ path: [null as unknown as string], displayName: 'Entry', mandatory: false }],
    };
    const query = service.generateDcqlQuery([{ credential, selectedClaims: credential.claims }]);
    expect((query as any).credentials[0]).not.toHaveProperty('claims');
    expect(readSimpleDcql(query)).not.toBeNull();
  });
});
