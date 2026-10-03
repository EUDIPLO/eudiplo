import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import type * as Redirects from '@docusaurus/plugin-client-redirects';
import 'dotenv/config';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'EUDIPLO',
  tagline: 'Middleware for the European Digital Identity Wallet ecosystem',
  favicon: 'img/logo.svg',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: 'https://docs.eudiplo.dev',
  baseUrl: '/',

  organizationName: 'openwallet-foundation',
  projectName: 'eudiplo',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/openwallet-foundation/eudiplo/edit/main/apps/docs/docs/',
          lastVersion: 'current',
          versions: {
            current: {
              label: 'Current',
            },
          },
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: ['@docusaurus/theme-mermaid'],
  markdown: {
    mermaid: true,
    // future.v4 disables MDX1-style HTML comments; keep them so pages can carry
    // `<!-- RESTRUCTURE: ... -->` notes during the docs restructure.
    mdx1Compat: {
      comments: true,
    },
  },

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          // 2026-10 restructure: Start / Cookbooks / Issuance / Presentation / Trust /
          // Operate / Reference / Concepts / Contributing / Upgrade. Every moved or
          // removed page redirects to its final target (no redirect chains).
          // Getting started -> Cookbooks.
          {from: '/getting-started', to: '/cookbooks'},
          {from: '/getting-started/quick-start', to: '/cookbooks/foundation'},
          {from: '/getting-started/first-credential', to: '/cookbooks/first-credential'},
          {from: '/getting-started/first-presentation', to: '/cookbooks/first-presentation'},
          {from: '/getting-started/wallet-registrars', to: '/trust/wallet-registrars'},
          {from: '/getting-started/next-steps', to: '/cookbooks'},
          {from: '/deployment/server-setup-cookbook', to: '/cookbooks/production-vm'},
          {from: '/deployment/production', to: '/showcase'},
          // Issuance.
          {from: '/issuance/authorization', to: '/issuance/authorization-servers'},
          {from: '/issuance/status-management', to: '/issuance/revocation'},
          {from: '/issuance/schema-metadata', to: '/trust/registrar'},
          // Presentation.
          {from: '/presentation/presentation-configuration', to: '/presentation/configure-verification'},
          {from: '/presentation/presentation-requests', to: '/presentation/requests'},
          {from: '/presentation/handling-results', to: '/presentation/receive-results'},
          // Trust.
          {from: '/trust/key-chains', to: '/trust/keys-and-certificates'},
          {from: '/trust/certificates', to: '/trust/keys-and-certificates'},
          // Administration and Deployment -> Operate.
          {from: '/deployment', to: '/operate'},
          {from: '/deployment/docker-compose', to: '/operate/docker-compose'},
          {from: '/deployment/kubernetes', to: '/operate/kubernetes'},
          {from: '/deployment/tls', to: '/operate/tls'},
          {from: '/deployment/cli', to: '/operate/cli'},
          {from: '/deployment/configuration-validation', to: '/operate/configuration-as-code'},
          {from: '/deployment/load-testing', to: '/operate/load-testing'},
          {from: '/deployment/environment-variables', to: '/reference/environment-variables'},
          {from: '/administration/tenants', to: '/operate/tenants-and-access'},
          {from: '/administration/authentication', to: '/operate/tenants-and-access'},
          {from: '/administration/keycloak', to: '/operate/keycloak'},
          {from: '/administration/keycloak-chained-as', to: '/cookbooks/issue-after-login'},
          {from: '/administration/database', to: '/operate/database'},
          {from: '/administration/kms', to: '/operate/kms'},
          {from: '/administration/monitoring', to: '/operate/monitoring'},
          {from: '/contributing/logging-configuration', to: '/operate/logging'},
          // Reference.
          {from: '/reference/openapi', to: '/reference/api'},
          {from: '/reference/credential-formats', to: '/reference/protocols'},
          {from: '/reference/web-client', to: '/cookbooks/foundation'},
          {from: '/generated/cli-reference', to: '/reference/cli'},
          // Architecture -> Concepts, guides and reference.
          {from: '/architecture', to: '/concepts'},
          {from: '/architecture/core-concepts', to: '/concepts'},
          {from: '/architecture/issuance', to: '/concepts/issuance'},
          {from: '/architecture/presentation', to: '/concepts/presentation'},
          {from: '/architecture/sessions', to: '/concepts/sessions'},
          {from: '/architecture/security', to: '/concepts/security-model'},
          {from: '/architecture/cryptography', to: '/concepts/security-model'},
          {from: '/architecture/authorization', to: '/issuance/authorization-servers'},
          {from: '/architecture/configuration-model', to: '/operate/configuration-as-code'},
          {from: '/architecture/storage', to: '/operate/object-storage'},
          {from: '/architecture/protocol-mapping', to: '/reference/protocols'},
          {from: '/architecture/extension-points/webhooks', to: '/reference/webhooks'},
          {from: '/architecture/extension-points/attribute-providers', to: '/reference/attribute-provider-api'},
          {from: '/architecture/extension-points/iae', to: '/issuance/interactive-authorization'},
          {from: '/architecture/extension-points/federation', to: '/trust/federation'},
          {from: '/architecture/backend-architecture', to: '/contributing/backend-architecture'},
          // The refactoring plan left the site: apps/backend/docs/refactoring-plan.md.
          {from: '/architecture/refactoring-plan', to: '/contributing/backend-architecture'},
          // Contributing.
          {from: '/contributing/repository-structure', to: '/contributing/development-setup'},
          {from: '/contributing/backend', to: '/contributing/backend-architecture'},
          {from: '/contributing/e2e-testing', to: '/contributing/testing'},
          {from: '/contributing/conformance-testing', to: '/contributing/testing'},
          // Migration -> Upgrade. Guides for 6.0 and older are linked from /upgrade
          // at the v8.1.0 git tag.
          {from: '/migration', to: '/upgrade'},
          {from: '/migration/7.x-to-8.0', to: '/upgrade/7.x-to-8.0'},
          {from: '/migration/6.x-to-7.0', to: '/upgrade/6.x-to-7.0'},
          {from: '/migration/5.x-to-6.0', to: '/upgrade'},
          {from: '/migration/4.x-to-5.0', to: '/upgrade'},
          {from: '/migration/3.x-to-4.0', to: '/upgrade'},
          // CLI 8.x prints this URL before an upgrade to 9.0. Point it at
          // /upgrade/8.x-to-9.0 once that guide exists.
          {from: '/migration/8.x-to-9.0', to: '/upgrade'},
          // Older URLs from earlier restructures (getting-started/, architecture/,
          // api/ and development/ sections).
          {from: '/getting-started/first-steps', to: '/cookbooks/first-credential'},
          {from: '/getting-started/usage', to: '/showcase'},
          {from: '/getting-started/wallet-compatibility', to: '/reference/wallet-compatibility'},
          {from: '/getting-started/web-client', to: '/cookbooks/foundation'},
          {from: '/getting-started/keycloak', to: '/operate/keycloak'},
          {from: '/getting-started/monitor', to: '/operate/monitoring'},
          {from: '/getting-started/registrar', to: '/trust/registrar'},
          {from: '/getting-started/cli', to: '/operate/cli'},
          {from: '/getting-started/cli/command-reference', to: '/reference/cli'},
          {from: '/getting-started/cli/configuration-validation', to: '/operate/configuration-as-code'},
          {from: '/getting-started/cli/development', to: '/contributing/cli'},
          {from: '/getting-started/cli/server-setup-cookbook', to: '/cookbooks/production-vm'},
          {from: '/getting-started/issuance', to: '/issuance'},
          {from: '/getting-started/issuance/credential-offers', to: '/issuance/credential-offers'},
          {from: '/getting-started/issuance/credential-configuration', to: '/issuance/credential-configuration'},
          {from: '/getting-started/issuance/attribute-provider', to: '/issuance/attribute-provider'},
          {from: '/getting-started/issuance/schema-metadata', to: '/trust/registrar'},
          {from: '/getting-started/issuance/issuance-configuration', to: '/issuance/issuance-configuration'},
          {from: '/getting-started/presentation', to: '/presentation'},
          {from: '/getting-started/presentation/presentation-requests', to: '/presentation/requests'},
          {from: '/getting-started/presentation/presentation-configuration', to: '/presentation/configure-verification'},
          {from: '/getting-started/presentation/transaction-data', to: '/presentation/transaction-data'},
          {from: '/architecture/key-management', to: '/operate/kms'},
          {from: '/architecture/tenant', to: '/operate/tenants-and-access'},
          {from: '/architecture/database', to: '/operate/database'},
          {from: '/architecture/trust-framework', to: '/trust/trust-lists'},
          {from: '/architecture/status-management', to: '/issuance/revocation'},
          {from: '/architecture/configuration-import', to: '/operate/configuration-as-code'},
          {from: '/architecture/configuration-portability', to: '/operate/configuration-as-code'},
          {from: '/architecture/supported-protocols', to: '/reference/protocols'},
          {from: '/architecture/webhooks', to: '/reference/webhooks'},
          {from: '/architecture/attribute-providers', to: '/reference/attribute-provider-api'},
          {from: '/architecture/iae', to: '/issuance/interactive-authorization'},
          {from: '/architecture/federation', to: '/trust/federation'},
          {from: '/api', to: '/reference/api'},
          {from: '/api/openapi', to: '/reference/api'},
          {from: '/api/authentication', to: '/operate/tenants-and-access'},
          {from: '/api/session-events', to: '/presentation/receive-results'},
          {from: '/development', to: '/contributing'},
          {from: '/development/workspace-structure', to: '/contributing/development-setup'},
          {from: '/development/backend-structure', to: '/contributing/backend-architecture'},
          {from: '/development/running-locally', to: '/contributing/development-setup'},
          {from: '/development/code-quality', to: '/contributing/code-quality'},
          {from: '/development/versioning', to: '/contributing/releases'},
          {from: '/development/contributing', to: '/contributing/documentation'},
          {from: '/development/testing', to: '/contributing/testing'},
          {from: '/development/logging-configuration', to: '/operate/logging'},
          {from: '/development/documentation-versioning', to: '/contributing/documentation'},
        ],
      } satisfies Redirects.Options,
    ],
  ],

  themeConfig: {
    image: 'img/eudiplo.png',
    // Consumed client-side by src/theme/Root.tsx and src/theme/SearchBar
    // to configure the DocSearch + Ask AI widgets (@docsearch/* v5).
    docSearchAskAi: {
      appId: process.env.ALGOLIA_APP_ID || 'YOUR_APP_ID',
      apiKey: process.env.ALGOLIA_SEARCH_API_KEY || 'YOUR_SEARCH_API_KEY',
      indices: [process.env.ALGOLIA_INDEX_NAME || 'Docs'],
      agentId: process.env.DOCSEARCH_AGENT_ID || 'YOUR_AGENT_ID',
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'EUDIPLO',
      logo: {
        alt: 'EUDIPLO Logo',
        src: 'img/logo.svg',
        href: 'https://eudiplo.dev',
        target: '_self',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://github.com/openwallet-foundation/eudiplo',
          label: 'GitHub',
          position: 'right',
        },
        {
          href: 'https://discord.gg/58ys8XfXDu',
          label: 'Discord',
          position: 'right',
        },
        {
          // MkDocs site for releases before the Docusaurus migration.
          href: 'https://openwallet-foundation.github.io/eudiplo/docs/latest/',
          label: 'Legacy Docs',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Cookbooks', to: '/cookbooks'},
            {label: 'Concepts', to: '/concepts'},
            {label: 'Contributing', to: '/contributing'},
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'Discord',
              href: 'https://discord.gg/58ys8XfXDu',
            },
            {
              label: 'GitHub Discussions',
              href: 'https://github.com/openwallet-foundation/eudiplo/discussions',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/openwallet-foundation/eudiplo',
            },
            {
              label: 'Contributing Guide',
              href: 'https://github.com/openwallet-foundation/eudiplo/blob/main/CONTRIBUTING.MD',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} OpenWallet Foundation | License: CC BY 4.0`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['json5'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
