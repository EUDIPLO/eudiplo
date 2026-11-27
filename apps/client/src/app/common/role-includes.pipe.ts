import { Pipe, type PipeTransform } from '@angular/core';
import { includedRoles } from '../services/role-grants';

/**
 * What a role includes besides itself, for the options of a role picker, such
 * as "includes issuance:offer, issuance:read"; empty for a role that includes
 * no other.
 */
@Pipe({ name: 'roleIncludes' })
export class RoleIncludesPipe implements PipeTransform {
  transform(role: string): string {
    const included = includedRoles(role);
    return included.length ? `includes ${included.join(', ')}` : '';
  }
}
