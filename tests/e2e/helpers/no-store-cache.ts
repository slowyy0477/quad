/** no-store forbids both private and shared caching; private alone does not. */
export function hasNoStoreCachePolicy(value: string | undefined): boolean {
  const directives = value?.toLowerCase().split(',').map(directive => directive.trim()) ?? []
  return directives.includes('no-store') && !directives.includes('public')
}
