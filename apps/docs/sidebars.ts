import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// Manually curated sidebar: user-facing concepts first, contributor/reference
// material further down. See docs/intro.md for the top-level mental model.
const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: '🚀 End-to-End Cookbook',
      link: {type: 'doc', id: 'getting-started/index'},
      items: [
        'getting-started/quick-start',
        'getting-started/wallet-registrars',
        'getting-started/first-credential',
        'getting-started/first-presentation',
        'getting-started/next-steps',
      ],
    },
    {
      type: 'category',
      label: '📤 Issuance',
      link: {type: 'doc', id: 'issuance/index'},
      items: [
        'issuance/credential-configuration',
        'issuance/issuance-configuration',
        'issuance/claims',
        'issuance/attribute-provider',
        'issuance/credential-offers',
        'issuance/authorization',
        'issuance/status-management',
        'issuance/notifications',
        'issuance/schema-metadata',
      ],
    },
    {
      type: 'category',
      label: '📥 Presentation',
      link: {type: 'doc', id: 'presentation/index'},
      items: [
        'presentation/presentation-configuration',
        'presentation/presentation-requests',
        'presentation/dcql',
        'presentation/transaction-data',
        'presentation/handling-results',
      ],
    },
    {
      type: 'category',
      label: '🔐 Trust & Security',
      link: {type: 'doc', id: 'trust/index'},
      items: [
        'trust/key-chains',
        'trust/certificates',
        'trust/registrar',
        'trust/registration-certificates',
        'trust/trust-lists',
      ],
    },
    {
      type: 'category',
      label: '⚙️ Administration',
      items: [
        'administration/tenants',
        'administration/authentication',
        'administration/keycloak',
        'administration/keycloak-chained-as',
        'administration/database',
        'administration/kms',
        'administration/monitoring',
      ],
    },
    {
      type: 'category',
      label: '🚀 Deployment',
      link: {type: 'doc', id: 'deployment/index'},
      items: [
        'deployment/docker-compose',
        'deployment/kubernetes',
        'deployment/tls',
        'deployment/cli',
        'deployment/server-setup-cookbook',
        'deployment/configuration-validation',
        'deployment/load-testing',
        'deployment/environment-variables',
        'deployment/production',
      ],
    },
    {
      type: 'category',
      label: '📖 Reference',
      items: [
        'reference/cli',
        'reference/protocols',
        'reference/credential-formats',
        'reference/wallet-compatibility',
        'reference/openapi',
        'reference/web-client',
      ],
    },
    {
      type: 'category',
      label: '🏗 Architecture',
      link: {type: 'doc', id: 'architecture/index'},
      items: [
        'architecture/core-concepts',
        'architecture/configuration-model',
        'architecture/issuance',
        'architecture/presentation',
        'architecture/authorization',
        'architecture/sessions',
        'architecture/protocol-mapping',
        'architecture/security',
        'architecture/cryptography',
        'architecture/storage',
        {
          type: 'category',
          label: 'Extension Points',
          items: [
            'architecture/extension-points/webhooks',
            'architecture/extension-points/attribute-providers',
            'architecture/extension-points/iae',
            'architecture/extension-points/federation',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: '🛠 Contributing',
      link: {type: 'doc', id: 'contributing/index'},
      items: [
        'contributing/development-setup',
        'contributing/repository-structure',
        'contributing/backend',
        'architecture/backend-architecture',
        'architecture/refactoring-plan',
         'architecture/dependency-audit',
        'contributing/client',
        'contributing/cli',
        'contributing/testing',
        'contributing/e2e-testing',
        'contributing/conformance-testing',
        'contributing/documentation',
        'contributing/code-quality',
        'contributing/logging-configuration',
        'contributing/releases',
      ],
    },
    {
      type: 'category',
      label: '🔄 Migration',
      link: {type: 'doc', id: 'migration/index'},
      items: [
        'migration/7.x-to-8.0',
        'migration/6.x-to-7.0',
        'migration/5.x-to-6.0',
        'migration/4.x-to-5.0',
        'migration/3.x-to-4.0',
      ],
    },
  ],
};

export default sidebars;
