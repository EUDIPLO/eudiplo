import { describe, expect, it } from 'vitest';
import { RoleIncludesPipe } from './role-includes.pipe';

describe('RoleIncludesPipe', () => {
  const pipe = new RoleIncludesPipe();

  it('names the roles a role includes', () => {
    expect(pipe.transform('issuance:offer')).toBe('includes issuance:read');
    expect(pipe.transform('issuance:manage')).toContain('issuance:offer');
    expect(pipe.transform('issuance:manage')).toContain('credentials:status');
  });

  it('is empty for a role that includes no other', () => {
    expect(pipe.transform('audit:read')).toBe('');
    expect(pipe.transform('unknown')).toBe('');
  });
});
