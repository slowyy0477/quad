import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { planStaffChange, provisionLocalStaff } from '../../scripts/bulla/local-staff.mjs'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

function fixture() {
  return {
    users: [{ id: 'usr_student', email: 'student@example.test', password_hash: 'original-synthetic-hash', created_at: '2026-01-01' }],
    profiles: [{ id: 'prf_student', user_id: 'usr_student', username: 'student', display_name: 'Student', visibility: 'private' }],
    user_roles: [] as { user_id: string; role: string }[],
    sessions: [{ id: 'ses_student', user_id: 'usr_student' }, { id: 'ses_other', user_id: 'usr_other' }],
    posts: [{ id: 'pst_keep', body: 'Synthetic content to preserve' }],
    profile_account_states: [] as { profile_id: string; status: string; suspended_until: string | null }[],
  }
}

describe('private local staff operator', () => {
  let workspace: TempWorkspace
  beforeEach(async () => {
    workspace = await createTempWorkspace('staff-operator')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  })
  afterEach(async () => { vi.unstubAllEnvs(); await workspace.cleanup() })

  it('does not confuse an existing ordinary account with a staff role', () => {
    const db = fixture()
    expect(() => planStaffChange(db, { email: 'student@example.test', role: 'admin' })).toThrow('without this staff role')
    expect(db.user_roles).toHaveLength(0)
    expect(db.users[0].password_hash).toBe('original-synthetic-hash')
  })

  it('requires explicit promotion and preserves the account password, sessions and content', () => {
    const db = fixture()
    const result = planStaffChange(db, { email: 'student@example.test', role: 'moderator', grantExisting: true })
    expect(result.status).toBe('granted')
    expect(result.password).toBeNull()
    expect(result.next.user_roles).toEqual([expect.objectContaining({ user_id: 'usr_student', role: 'moderator' })])
    expect(result.next.users).toEqual(db.users)
    expect(result.next.sessions).toEqual(db.sessions)
    expect(result.next.posts).toEqual(db.posts)
    expect(db.user_roles).toHaveLength(0)
  })

  it('leaves an existing administrator untouched without an explicit reset', () => {
    const db = fixture()
    db.user_roles.push({ user_id: 'usr_student', role: 'admin' })
    const result = planStaffChange(db, { email: 'student@example.test', role: 'admin' })
    expect(result.status).toBe('unchanged')
    expect(result.next).toEqual(db)
    expect(result.password).toBeNull()
  })

  it('creates a private, unsearchable moderator and an actual matching role', () => {
    const result = planStaffChange(fixture(), { role: 'moderator' })
    expect(result.status).toBe('created')
    expect(result.password?.length).toBe(28)
    expect(result.next.users[1].password_hash).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/)
    expect(result.next.profiles[1]).toMatchObject({ user_id: result.userId, visibility: 'private', searchable: false, onboarding_completed: true })
    expect(result.next.user_roles[0]).toMatchObject({ user_id: result.userId, role: 'moderator' })
  })

  it('rotates only an explicitly selected staff account and revokes its old sessions', () => {
    const db = fixture()
    db.user_roles.push({ user_id: 'usr_student', role: 'admin' })
    const result = planStaffChange(db, { email: 'student@example.test', role: 'admin', reset: true })
    expect(result.next.users[0].password_hash).not.toBe(db.users[0].password_hash)
    expect(result.next.sessions).toEqual([{ id: 'ses_other', user_id: 'usr_other' }])
    expect(result.next.posts).toEqual(db.posts)
  })

  it('does not reactivate disabled or currently suspended accounts', () => {
    const disabled = { ...fixture(), users: [{ ...fixture().users[0], disabled_at: '2026-01-01' }] }
    expect(() => planStaffChange(disabled, { email: 'student@example.test', grantExisting: true })).toThrow('disabled')
    const suspended = fixture()
    suspended.profile_account_states.push({ profile_id: 'prf_student', status: 'suspended', suspended_until: null })
    expect(() => planStaffChange(suspended, { email: 'student@example.test', grantExisting: true })).toThrow('suspended')
  })

  it('rejects a conflicting username without modifying the input', () => {
    const db = fixture()
    expect(() => planStaffChange(db, { username: 'student' })).toThrow('already taken')
    expect(db.users).toHaveLength(1)
  })

  it('refuses cloud mode even with an explicit local path', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
    await expect(provisionLocalStaff({ store: path.join(workspace.directory, 'local.json'), apply: true })).rejects.toThrow('requires NEXT_PUBLIC_DATA_MODE=local')
  })

  it('defaults to a dry run and keeps the entire datastore unchanged', async () => {
    const store = path.join(workspace.directory, 'local.json')
    await fs.writeFile(store, JSON.stringify(fixture()))
    const original = await fs.readFile(store, 'utf8')
    const result = await provisionLocalStaff({ store, credentialsDirectory: path.join(workspace.directory, 'credentials') })
    expect(result.status).toBe('dry-run')
    expect(await fs.readFile(store, 'utf8')).toBe(original)
    expect(result).not.toHaveProperty('password')
    expect(result).not.toHaveProperty('next')
  })

  it('commits atomically, keeps a backup and returns no credentials', async () => {
    const store = path.join(workspace.directory, 'local.json')
    await fs.writeFile(store, JSON.stringify(fixture()))
    const result = await provisionLocalStaff({ store, role: 'moderator', apply: true, credentialsDirectory: path.join(workspace.directory, 'credentials') })
    expect(result.status).toBe('created')
    const updated = JSON.parse(await fs.readFile(store, 'utf8'))
    expect(updated.users).toHaveLength(2)
    expect(updated.posts).toEqual(fixture().posts)
    expect(JSON.parse(await fs.readFile(result.backupFile!, 'utf8'))).toEqual(fixture())
    const credentials = await fs.readFile(result.credentialFile!, 'utf8')
    expect(credentials).toContain('Role: moderator')
    const password = credentials.match(/Password: (.+)/)?.[1]
    expect(password).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain(password)
    await expect(fs.stat(`${store}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
