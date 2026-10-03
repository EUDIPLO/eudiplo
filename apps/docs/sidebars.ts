import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// Manually curated sidebar: cookbooks first, then single-topic guides
// (Issuance, Presentation, Trust, Operate), reference, concepts, contributor
// material and upgrade guides. Every page under docs/ (except `_`-prefixed
// paths) must be listed here; `pnpm --filter @eudiplo/docs test` fails on
// orphans (scripts/check-sidebar-orphans.ts).
const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: '🚀 Cookbooks',
      link: {type: 'doc', id: 'cookbooks/index'},
      items: [
        {
          // One recipe in three chapters; the other cookbooks are single pages.
          type: 'category',
          label: 'Issue and verify a credential',
          collapsed: false,
          items: [
            'cookbooks/foundation',
            'cookbooks/first-credential',
            'cookbooks/first-presentation',
          ],
        },
        'cookbooks/integrate-backend',
        'cookbooks/issue-after-login',
        'cookbooks/revocable-credentials',
        'cookbooks/trusted-issuers',
        'cookbooks/production-vm',
        'troubleshooting',
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
        'issuance/deferred-issuance',
        'issuance/credential-offers',
        'issuance/authorization-servers',
        'issuance/interactive-authorization',
        'issuance/revocation',
        'issuance/notifications',
      ],
    },
    {
      type: 'category',
      label: '📥 Presentation',
      link: {type: 'doc', id: 'presentation/index'},
      items: [
        'presentation/configure-verification',
        'presentation/requests',
        'presentation/dcql',
        'presentation/transaction-data',
        'presentation/receive-results',
      ],
    },
    {
      type: 'category',
      label: '🔐 Trust',
      link: {type: 'doc', id: 'trust/index'},
      items: [
        'trust/keys-and-certificates',
        'trust/registrar',
        'trust/registration-certificates',
        'trust/trust-lists',
        'trust/federation',
        'trust/attestation',
        'trust/wallet-registrars',
      ],
    },
    {
      type: 'category',
      label: '⚙️ Operate',
      link: {type: 'doc', id: 'operate/index'},
      items: [
        'operate/docker-compose',
        'operate/kubernetes',
        'operate/tls',
        'operate/cli',
        'operate/configuration-as-code',
        'operate/tenants-and-access',
        'operate/keycloak',
        'operate/database',
        'operate/encryption-keys',
        'operate/object-storage',
        'operate/kms',
        'operate/logging',
        'operate/monitoring',
        'operate/load-testing',
        'operate/production-checklist',
      ],
    },
    {
      type: 'category',
      label: '📖 Reference',
      items: [
        'reference/protocols',
        'reference/api',
        'reference/cli',
        'reference/environment-variables',
        'reference/roles',
        'reference/kms-config',
        'reference/config-bundle-format',
        'reference/webhooks',
        'reference/presentation-configuration',
        'reference/session-outcome',
        'reference/attribute-provider-api',
        'reference/credential-configuration',
        'reference/wallet-compatibility',
      ],
    },
    {
      type: 'category',
      label: '🏗 Concepts',
      link: {type: 'doc', id: 'concepts/index'},
      items: [
        'concepts/issuance',
        'concepts/presentation',
        'concepts/sessions',
        'concepts/security-model',
      ],
    },
    {
      type: 'category',
      label: '🛠 Contributing',
      link: {type: 'doc', id: 'contributing/index'},
      items: [
        'contributing/development-setup',
        'contributing/backend-architecture',
        'contributing/client',
        'contributing/cli',
        'contributing/testing',
        'contributing/documentation',
        'contributing/releases',
        'contributing/code-quality',
        'contributing/configuration-schemas',
      ],
    },
    {
      type: 'category',
      label: '🔄 Upgrade',
      link: {type: 'doc', id: 'upgrade/index'},
      items: ['upgrade/8.x-to-9.0', 'upgrade/7.x-to-8.0', 'upgrade/6.x-to-7.0'],
    },
    'showcase',
  ],
};

export default sidebars;
