import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import { createTempWorkspace } from './temp-workspace'
import { runWithImageRequest } from './image-request-cookies'
import type { LocalProfile, LocalProject, Tables } from '../../src/lib/local/db'

/** Synthetic fixtures only. Never read the configured owner DB or .env.local. */
export async function createImageUploadFixture() {
  const workspace = await createTempWorkspace('safe-images',
    process.platform === 'win32' ? 'D:\\All tasks + Automations\\Bulla-Recovery\\safe-upload-fixtures' : undefined)
  const dataPath = path.join(workspace.directory, 'local.json')
  const mediaRoot = path.join(workspace.directory, 'private-images')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('LOCAL_DATA_PATH', dataPath)
  vi.stubEnv('BULLA_LOCAL_MEDIA_ROOT', mediaRoot)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
  const db = await import('../../src/lib/local/db')
  const now = new Date().toISOString()
  const actors = ['owner', 'maintainer', 'member', 'outsider'].map(name => ({
    name, userId: `usr_images${name}`, profileId: `prf_images${name}`,
    token: randomBytes(32).toString('base64url'),
  }))
  const [owner, maintainer, member, outsider] = actors
  const project: LocalProject = {
    id: 'prj_imagesprivate', owner_id: owner.profileId, slug: 'synthetic-private-images',
    title: 'Synthetic images project', purpose: 'Fixture only', description: 'No real content',
    category: 'web', status: 'active', visibility: 'private', is_seeking_members: false,
    team_size_target: null, member_count: 3, created_at: now, deleted_at: null,
  }
  // Bootstrap only this fresh, exclusive synthetic fixture before any request.
  // Protected project writes now require a session from the pre-write snapshot;
  // do not weaken that guard or pretend an as-yet-unseeded session is verified.
  if (db.localStorePath() !== dataPath) throw new Error('Image fixture store was not isolated')
  const snapshot = await db.readStore()
  {
    for (const actor of actors) {
      snapshot.users.push({
        id: actor.userId, email: `${actor.name}@images.test.example`,
        password_hash: 'synthetic-fixture-not-for-signin', created_at: now,
      })
      const profile: LocalProfile = {
        id: actor.profileId, user_id: actor.userId, username: `images_${actor.name}`,
        display_name: `Synthetic ${actor.name}`, bio: null, avatar_url: null, university_id: null,
        department: null, programme: null, semester: null, website: null, github: null,
        visibility: 'public', searchable: true, created_at: now,
      }
      snapshot.profiles.push(profile)
      snapshot.sessions.push({
        id: `ses_images${actor.name}`, user_id: actor.userId,
        token_hash: createHash('sha256').update(actor.token).digest('hex'),
        created_at: now, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
    }
    snapshot.projects.push(project)
    for (const actor of [owner, maintainer, member]) snapshot.project_members.push({
      id: `mem_images${actor.name}`, project_id: project.id, profile_id: actor.profileId,
      role: actor.name === 'owner' ? 'owner' : actor.name === 'maintainer' ? 'maintainer' : 'member',
      created_at: now,
    })
  }
  await fs.writeFile(dataPath, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
  function request(
    actor: typeof owner | null,
    body?: BodyInit,
    headers: Record<string, string> = {},
    route = '/api/uploads/avatar',
    signal?: AbortSignal,
  ) {
    return new Request(`http://127.0.0.1:3999${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'image/png', origin: 'http://127.0.0.1:3999' }),
        ...(actor ? { cookie: `quad_local_session=${actor.token}` } : {}),
        ...headers,
      },
      body, signal, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)
  }
  function mutateAs<T>(actor: typeof owner, change: (snapshot: Tables) => T | Promise<T>): Promise<T> {
    return runWithImageRequest(request(actor), () => db.mutate(change))
  }
  return { ...workspace, dataPath, mediaRoot, db, owner, maintainer, member, outsider, project, request, mutateAs }
}
