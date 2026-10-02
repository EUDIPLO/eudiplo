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
  onBrokenAnchors: 'warn',

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
  },

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          // Legacy MkDocs "getting-started" paths that moved elsewhere.
          {from: '/getting-started/first-steps', to: '/getting-started/first-credential'},
          {from: '/getting-started/usage', to: '/deployment/production'},
          {from: '/getting-started/wallet-compatibility', to: '/reference/wallet-compatibility'},
          {from: '/getting-started/web-client', to: '/reference/web-client'},
          {from: '/getting-started/keycloak', to: '/administration/keycloak'},
          {from: '/getting-started/monitor', to: '/administration/monitoring'},
          {from: '/getting-started/registrar', to: '/trust/registrar'},
          {from: '/getting-started/cli', to: '/deployment/cli'},
          {from: '/getting-started/cli/command-reference', to: '/reference/cli'},
          {from: '/getting-started/cli/configuration-validation', to: '/deployment/configuration-validation'},
          {from: '/getting-started/cli/development', to: '/contributing/cli'},
          {from: '/getting-started/cli/server-setup-cookbook', to: '/deployment/server-setup-cookbook'},
          // Issuance / Presentation moved out from under getting-started/.
          {from: '/getting-started/issuance', to: '/issuance'},
          {from: '/getting-started/issuance/credential-offers', to: '/issuance/credential-offers'},
          {from: '/getting-started/issuance/credential-configuration', to: '/issuance/credential-configuration'},
          {from: '/getting-started/issuance/attribute-provider', to: '/issuance/attribute-provider'},
          {from: '/getting-started/issuance/schema-metadata', to: '/issuance/schema-metadata'},
          {from: '/getting-started/issuance/issuance-configuration', to: '/issuance/issuance-configuration'},
          {from: '/getting-started/presentation', to: '/presentation'},
          {from: '/getting-started/presentation/presentation-requests', to: '/presentation/presentation-requests'},
          {from: '/getting-started/presentation/presentation-configuration', to: '/presentation/presentation-configuration'},
          {from: '/getting-started/presentation/transaction-data', to: '/presentation/transaction-data'},
          // Architecture pages that were split or renamed.
          {from: '/architecture/key-management', to: '/administration/kms'},
          {from: '/architecture/tenant', to: '/administration/tenants'},
          {from: '/architecture/database', to: '/administration/database'},
          {from: '/architecture/trust-framework', to: '/trust/trust-lists'},
          {from: '/architecture/status-management', to: '/issuance/status-management'},
          {from: '/architecture/configuration-import', to: '/architecture/configuration-model'},
          {from: '/architecture/configuration-portability', to: '/architecture/configuration-model'},
          {from: '/architecture/supported-protocols', to: '/reference/protocols'},
          {from: '/architecture/webhooks', to: '/architecture/extension-points/webhooks'},
          {from: '/architecture/attribute-providers', to: '/architecture/extension-points/attribute-providers'},
          {from: '/architecture/iae', to: '/architecture/extension-points/iae'},
          {from: '/architecture/federation', to: '/architecture/extension-points/federation'},
          // API section merged into reference/administration.
          {from: '/api', to: '/reference/openapi'},
          {from: '/api/openapi', to: '/reference/openapi'},
          {from: '/api/authentication', to: '/administration/authentication'},
          {from: '/api/session-events', to: '/presentation/handling-results'},
          // Development -> Contributing.
          {from: '/development', to: '/contributing'},
          {from: '/development/workspace-structure', to: '/contributing/repository-structure'},
          {from: '/development/backend-structure', to: '/contributing/backend'},
          {from: '/development/running-locally', to: '/contributing/development-setup'},
          {from: '/development/code-quality', to: '/contributing/code-quality'},
          {from: '/development/versioning', to: '/contributing/releases'},
          {from: '/development/contributing', to: '/contributing/documentation'},
          {from: '/development/testing', to: '/contributing/testing'},
          {from: '/development/logging-configuration', to: '/contributing/logging-configuration'},
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
          href: 'https://docs.eudiplo.dev/',
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
            {label: 'Getting Started', to: '/getting-started'},
            {label: 'Architecture', to: '/architecture'},
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
