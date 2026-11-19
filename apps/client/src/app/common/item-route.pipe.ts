import { Pipe, type PipeTransform } from '@angular/core';

/**
 * Router commands for an item below the current list route, such as its page
 * (`id | itemRoute`) or its editor (`id | itemRoute: 'edit'`).
 *
 * The router splits the first command on `/`, so `[id]` or a plain `id` turns
 * an ID such as `team/hook` into two segments and a route that does not exist.
 * The leading `./` makes the ID a later command, which the router keeps as one
 * encoded segment (`team%2Fhook`).
 */
@Pipe({ name: 'itemRoute' })
export class ItemRoutePipe implements PipeTransform {
  transform(id: string, ...rest: string[]): string[] {
    return ['./', id, ...rest];
  }
}
