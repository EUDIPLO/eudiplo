/** The path of a router URL, without its query and fragment. */
export function urlPath(url: string): string {
  return url.split(/[?#]/)[0];
}
