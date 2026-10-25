import type { MatSnackBar } from '@angular/material/snack-bar';
import type { DefaultAccessKeyChainDto } from '@eudiplo/sdk-core';

import { reportSourceFailures } from '../common/load-source';
import { getApiErrorMessage } from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';
import type { KeyChainService } from './key-chain.service';

/** What the default access key chain signs, for tooltips. */
const USED_FOR =
  'It signs presentation requests of configurations without an access key chain and the signed issuer metadata.';

/** Chip of the access key chain used where no configuration names one, or undefined. */
export function defaultAccessChip(
  info: DefaultAccessKeyChainDto | undefined,
  keyChainId: string
): { label: string; tooltip: string } | undefined {
  if (!info || info.keyChainId !== keyChainId) return undefined;
  return info.defaultAccessKeyChainId === keyChainId
    ? { label: 'Default', tooltip: `Default access key chain of this tenant. ${USED_FOR}` }
    : {
        label: 'Default by rule',
        tooltip: `No default access key chain is set, so EUDIPLO picks this one by rule. ${USED_FOR}`,
      };
}

/** True when the tenant names the key chain as its default access key chain. */
export function isConfiguredDefaultAccess(
  info: DefaultAccessKeyChainDto | undefined,
  keyChainId: string
): boolean {
  return info?.defaultAccessKeyChainId === keyChainId;
}

/** Tooltip of the button that sets or removes the key chain as the default. */
export function defaultAccessToggleTooltip(
  info: DefaultAccessKeyChainDto | undefined,
  keyChainId: string
): string {
  return isConfiguredDefaultAccess(info, keyChainId)
    ? 'Stop using as default access key chain'
    : 'Use as default access key chain';
}

/**
 * Accessible name of that button, which names the key chain. The name says what a press does,
 * so the button carries no `aria-pressed`.
 */
export function defaultAccessToggleLabel(
  info: DefaultAccessKeyChainDto | undefined,
  keyChainId: string,
  name: string
): string {
  return isConfiguredDefaultAccess(info, keyChainId)
    ? `Stop using key chain ${name} as default access key chain`
    : `Use key chain ${name} as default access key chain`;
}

/** Snackbar text after the default access key chain changed. */
export function defaultAccessChangedMessage(info: DefaultAccessKeyChainDto): string {
  return info.defaultAccessKeyChainId
    ? 'Default access key chain set'
    : 'Default access key chain removed; EUDIPLO picks one by rule';
}

/** Why deleting the key chain is refused before asking, or undefined. */
export function defaultAccessDeleteRefusal(
  info: DefaultAccessKeyChainDto | undefined,
  keyChainId: string
): string | undefined {
  return isConfiguredDefaultAccess(info, keyChainId)
    ? "This is the tenant's default access key chain. Stop using it as default before you delete it."
    : undefined;
}

/** Warning when the tenant's default access key chain no longer exists, or undefined. */
export function missingDefaultAccessMessage(
  info: DefaultAccessKeyChainDto | undefined
): string | undefined {
  if (!info?.defaultAccessKeyChainId || info.keyChainId) return undefined;
  return (
    `The default access key chain "${info.defaultAccessKeyChainId}" no longer exists, so` +
    ' presentation requests without their own access key chain and the signed issuer metadata' +
    ' fail. Remove the default or choose another access key chain.'
  );
}

/**
 * Loads the tenant's default access key chain; a failure is reported and gives undefined, so
 * the page stays usable without it.
 */
export async function loadDefaultAccess(
  keyChainService: KeyChainService,
  snackBar: MatSnackBar
): Promise<DefaultAccessKeyChainDto | undefined> {
  try {
    return await keyChainService.getDefaultAccess();
  } catch (error) {
    console.error('Failed to load the default access key chain:', error);
    reportSourceFailures(snackBar, [{ label: 'the default access key chain', error }]);
    return undefined;
  }
}

/**
 * Sets `keyChainId` as the tenant's default access key chain, or with null removes the
 * default, and says so; gives the new state, or undefined when the request failed.
 */
export async function changeDefaultAccess(
  keyChainService: KeyChainService,
  snackBar: MatSnackBar,
  keyChainId: string | null
): Promise<DefaultAccessKeyChainDto | undefined> {
  try {
    const info = await keyChainService.setDefaultAccess(keyChainId);
    snackBar.open(defaultAccessChangedMessage(info), 'Dismiss', { duration: 3000 });
    return info;
  } catch (error) {
    console.error('Failed to change the default access key chain:', error);
    openErrorSnackBar(
      snackBar,
      getApiErrorMessage(error, 'Failed to change the default access key chain'),
      'Dismiss'
    );
    return undefined;
  }
}
