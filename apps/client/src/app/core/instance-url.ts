/** `url` without the slashes it ends with, as the instance URL is kept and compared. */
export function withoutTrailingSlashes(url: string): string {
  let trimmed = url;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}
