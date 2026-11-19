/** The usages a key chain can have, as the key pages show them. */
export type KeyUsageType =
  'attestation' | 'statusList' | 'access' | 'authorizationServer' | 'trustList' | 'federation';

/**
 * Label, short label for chips and tables, icon and description of each key chain usage.
 * The key list, the key page and the create wizard all take their icon from here.
 */
export const keyUsages: Record<
  KeyUsageType,
  { label: string; short: string; icon: string; description: string }
> = {
  attestation: {
    label: 'Credential Signing Keys',
    short: 'Credential Signing',
    icon: 'card_membership',
    description:
      'Keys for signing Electronic Attestations of Attributes (EAAs) issued to wallets. Each credential type has its own isolated key chain.',
  },
  access: {
    label: 'EUDI Wallet Access Certificate Keys',
    short: 'Access Certificate',
    icon: 'assignment_ind',
    description: 'Keys for EUDI Wallet Access Certificates to authenticate to the wallet.',
  },
  authorizationServer: {
    label: 'Authorization Server Keys',
    short: 'Authorization Server',
    icon: 'token',
    description:
      'Keys that sign the OAuth access tokens of the authorization servers. They never sign credentials or requests to wallets.',
  },
  statusList: {
    label: 'Status List Keys',
    short: 'Status List',
    icon: 'format_list_bulleted',
    description: 'Keys for signing credential status lists (revocation/suspension).',
  },
  trustList: {
    label: 'Trust List Keys',
    short: 'Trust List',
    icon: 'shield',
    description: 'Keys for signing trust list entries.',
  },
  federation: {
    label: 'OpenID Federation Entity Keys',
    short: 'Federation',
    icon: 'hub',
    description:
      'Keys for signing the entity configuration of the OpenID Federation entity. They never sign credentials or requests.',
  },
};
