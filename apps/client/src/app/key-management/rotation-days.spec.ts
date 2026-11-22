import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';

import { rotationDaysValidators } from './rotation-days';

describe('rotationDaysValidators', () => {
  const valid = (value: unknown) => new FormControl(value, rotationDaysValidators).valid;

  it('accepts a whole number of days from 1 to 3650', () => {
    expect(valid(1)).toBe(true);
    expect(valid(3650)).toBe(true);
    expect(valid('30')).toBe(true);
  });

  it('rejects an empty value, 0, more than 3650 days and fractions', () => {
    for (const value of [null, '', 0, 3651, 1.5]) {
      expect(valid(value), String(value)).toBe(false);
    }
  });
});
