import type { Tables } from '@/lib/local/db'
import { id, now } from '@/lib/local/db'
import { profileActive } from '@/lib/local/access'

/** Called only inside the authenticated connection transaction, not a server action. */
export function awardConnectionAchievement(db: Tables, profileIds: string[]): void {
  const key = 'first_connection'
  if (!db.achievement_definitions.some(row => row.key === key)) db.achievement_definitions.push({ id: id('acd'), key, name: 'First Connection', description: 'You and another student connected.', criteria: 'Accepted 1 connection.', category: 'community', tier: 'bronze', icon: 'link', sort_order: 30, is_active: true, created_at: now() })
  if (!db.achievement_definitions.some(row => row.key === key && row.is_active)) return
  for (const profileId of profileIds) {
    const count = db.connections.filter(row => row.status === 'accepted' && (row.requester_id === profileId || row.addressee_id === profileId)).length
    if (!profileActive(db, profileId) || count < 1 || db.profile_achievements.some(row => row.profile_id === profileId && row.achievement_key === key)) continue
    db.profile_achievements.push({ id: id('ach'), profile_id: profileId, achievement_key: key, awarded_at: now(), awarded_value: count, is_pinned: false })
  }
}
