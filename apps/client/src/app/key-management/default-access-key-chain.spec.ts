import { describe, expect, it } from 'vitest';

import {
  defaultAccessChangedMessage,
  defaultAccessChip,
  defaultAccessToggleLabel,
  defaultAccessToggleTooltip,
  isConfiguredDefaultAccess,
} from './default-access-key-chain';

describe('default access key chain', () => {
  it('marks the configured default', () => {
    const info = { defaultAccessKeyChainId: 'a', keyChainId: 'a' };

    expect(defaultAccessChip(info, 'a')?.label).toBe('Default');
    expect(defaultAccessChip(info, 'b')).toBeUndefined();
    expect(isConfiguredDefaultAccess(info, 'a')).toBe(true);
    expect(defaultAccessToggleTooltip(info, 'a')).toBe('Stop using as default access key chain');
    expect(defaultAccessToggleLabel(info, 'a', 'Registrar')).toBe(
      'Stop using key chain Registrar as default access key chain'
    );
  });

  it('marks the key chain picked by rule while none is set', () => {
    const info = { keyChainId: 'a' };

    expect(defaultAccessChip(info, 'a')).toEqual({
      label: 'Default by rule',
      tooltip: expect.stringContaining('EUDIPLO picks this one by rule'),
    });
    expect(isConfiguredDefaultAccess(info, 'a')).toBe(false);
    expect(defaultAccessToggleTooltip(info, 'a')).toBe('Use as default access key chain');
  });

  it('marks nothing before the default is known', () => {
    expect(defaultAccessChip(undefined, 'a')).toBeUndefined();
  });

  it('says whether the default was set or removed', () => {
    expect(defaultAccessChangedMessage({ defaultAccessKeyChainId: 'a', keyChainId: 'a' })).toBe(
      'Default access key chain set'
    );
    expect(defaultAccessChangedMessage({ keyChainId: 'a' })).toBe(
      'Default access key chain removed; EUDIPLO picks one by rule'
    );
  });
});
