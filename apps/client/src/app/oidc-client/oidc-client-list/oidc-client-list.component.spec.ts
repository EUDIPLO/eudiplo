import { describe } from 'vitest';

import { describeListStates } from '../../common/base-async-list.testing';
import { OidcClientService } from '../oidc-client.service';
import { OidcClientListComponent } from './oidc-client-list.component';

describe('OidcClientListComponent', () => {
  describeListStates({
    component: OidcClientListComponent,
    service: OidcClientService,
    fetchMethod: 'getAll',
    item: {
      id: 'c7d1',
      name: 'Customer Portal',
      redirectUris: ['https://portal.example/cb'],
      profile: 'secure',
      scopes: [{ scope: 'pid', presentationConfigId: 'pid' }],
      secrets: [],
      issuer: 'https://eudiplo.example/verifiers/root/oidc',
    },
    loading: 'Loading OIDC clients',
    empty: 'No OIDC clients yet.',
    create: 'Create OIDC Client',
    createButton: 'Create New OIDC Client',
    failure: 'Failed to load OIDC clients',
  });
});
