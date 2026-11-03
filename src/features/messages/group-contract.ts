/** Per-request/member bounds; not a claim about hosted throughput or capacity. */
export const GROUP_HANDLE_LIMIT = 10
export const GROUP_ACTIVE_LIMIT = 20
export const GROUP_RECORDED_LIMIT = 50
export const GROUP_TITLE_LIMIT = 120

export const GROUP_REACHABILITY_COPY =
  'People are added immediately, not sent a pending invitation. Only accepted connections who currently accept your direct messages and have a readable profile can be added. Blocking with any recorded member prevents an addition.'

export const GROUP_SKIP_COPY =
  'Not added: already active, unavailable, not reachable under those rules, or a group limit was reached. No private reason is disclosed.'

export const FINAL_GROUP_ADMIN_COPY =
  'You are the final active admin. Make another active member an admin before leaving or changing your role.'

export const GROUP_UNAVAILABLE_COPY =
  'This group is not available for you to manage. Only a current active admin can make that change.'

export function groupAdditionCopy(added: number, skipped: number) {
  return `${added} ${added === 1 ? 'person' : 'people'} added.${skipped > 0 ? ` ${skipped} not added. ${GROUP_SKIP_COPY}` : ''}`
}
