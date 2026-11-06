import { describe, expect, it } from 'vitest';
import { isWalletColor } from './wallet-color';

describe('isWalletColor', () => {
  it('accepts empty values and the CSS Color Level 3 numerical forms', () => {
    for (const value of [
      undefined,
      null,
      '',
      '  ',
      '#fff',
      '#12107C',
      ' #12107c ',
      'rgb(18, 16, 124)',
      'rgba(18, 16, 124, 0.5)',
      'rgb(7%, 6%, 49%)',
      'hsl(242, 77%, 27%)',
      'HSLA(242, 77%, 27%, 1)',
      'transparent',
    ]) {
      expect(isWalletColor(value), String(value)).toBe(true);
    }
  });

  it('flags keywords, typos and newer color forms', () => {
    for (const value of [
      'navy',
      'blu',
      '#FFFFF',
      '#12107c80',
      'oklch(40% 0.2 270)',
      'rgb(',
      'rgb()',
      'rgb(foo)',
      'rgb(18 16 124)',
      'hsl(x)',
      'hsl(242, 77, 27)',
    ]) {
      expect(isWalletColor(value), value).toBe(false);
    }
  });
});
