/** Code-unit order, independent of locale. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
