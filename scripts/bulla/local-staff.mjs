import { randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const taskDirectory = 'D:/All tasks + Automations/Bulla-Recovery'
const staffRoles = new Set(['admin', 'moderator'])
const makeId = prefix => `${prefix}_${randomBytes(12).toString('hex')}`

function makePassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  return Array.from({ length: 28 }, () => alphabet[randomInt(alphabet.length)]).join('')
}

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
}

/** Plan without mutating the caller's snapshot or silently promoting an account. */
export function planStaffChange(snapshot, options) {
  const role = options.role || 'admin'
  if (!staffRoles.has(role)) throw new Error('Role must be admin or moderator.')
  const email = (options.email || `${role}@bulla.local`).trim().toLowerCase()
  const username = options.username || `bulla_${role}`
  const displayName = (options.displayName || (role === 'admin' ? 'Bulla Administrator' : 'Bulla Moderator')).trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid staff email.')
  if (!/^[a-z][a-z0-9_]{2,23}$/.test(username)) throw new Error('Invalid staff username.')
  if (displayName.length < 2 || displayName.length > 80) throw new Error('Invalid display name.')
  for (const table of ['users', 'profiles', 'user_roles']) {
    if (!Array.isArray(snapshot[table])) throw new Error(`Invalid local store table: ${table}.`)
  }
  if (snapshot.sessions !== undefined && !Array.isArray(snapshot.sessions)) throw new Error('Invalid sessions table.')
  const next = structuredClone(snapshot)
  let user = next.users.find(row => row.email.trim().toLowerCase() === email)
  const heldRole = user && next.user_roles.find(row => row.user_id === user.id &&
    (row.role === role || (role === 'moderator' && row.role === 'admin')))
  if (user?.disabled_at != null) throw new Error('Refusing to reactivate a disabled account.')
  let profile = user && next.profiles.find(row => row.user_id === user.id)
  const state = profile && (next.profile_account_states || []).find(row => row.profile_id === profile.id)
  if (state?.status === 'suspended' && (!state.suspended_until ||
    !Number.isFinite(Date.parse(state.suspended_until)) || Date.parse(state.suspended_until) > Date.now())) {
    throw new Error('Refusing to change staff access for a suspended account.')
  }
  if (user && !heldRole && !options.grantExisting) {
    throw new Error('Account exists without this staff role. Use --grant-existing only after verifying its owner; no password was changed.')
  }
  if (heldRole && !options.reset) {
    if (!profile) throw new Error('Existing staff account has no profile; repair it explicitly.')
    return { status: 'unchanged', next, role, email, userId: user.id, password: null }
  }
  const timestamp = new Date().toISOString()
  const password = !user || options.reset ? makePassword() : null
  const status = user ? (password ? 'rotated' : 'granted') : 'created'
  if (!user) {
    user = { id: makeId('usr'), email, password_hash: passwordHash(password), created_at: timestamp }
    next.users.push(user)
  } else if (password) {
    user.password_hash = passwordHash(password)
    next.sessions = (next.sessions || []).filter(row => row.user_id !== user.id)
  }
  if (!profile) {
    if (next.profiles.some(row => row.username.toLowerCase() === username.toLowerCase())) throw new Error('Staff username is already taken.')
    profile = {
      id: makeId('prf'), user_id: user.id, username, display_name: displayName,
      bio: null, avatar_url: null, university_id: null, department: null,
      programme: null, semester: null, website: null, github: null,
      visibility: 'private', searchable: false, onboarding_completed: true,
      onboarding_step: 1, created_at: timestamp,
    }
    next.profiles.push(profile)
  }
  if (!heldRole) next.user_roles.push({ id: makeId('rol'), user_id: user.id, role, created_at: timestamp })
  return { status, next, role, email, userId: user.id, profileId: profile.id, password }
}

function requireDedicatedAbsolute(value, label) {
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error(`${label} must be an absolute, dedicated path.`)
  }
  return path.resolve(value)
}

function requireOutsideRepository(repository, target) {
  const relative = path.relative(repository, target)
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Credentials must be kept outside the source checkout.')
  }
}

async function selectedEnvironment() {
  try { return parse(await fs.readFile(path.join(process.cwd(), '.env.local'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}

/** Uses the same `<store>.lock` and atomic rename as the app; never reseeds. */
export async function provisionLocalStaff(options) {
  const fileEnvironment = await selectedEnvironment()
  if ((process.env.NEXT_PUBLIC_DATA_MODE ?? fileEnvironment.NEXT_PUBLIC_DATA_MODE) !== 'local') {
    throw new Error('Local staff provisioning requires NEXT_PUBLIC_DATA_MODE=local.')
  }
  const requestedStore = options.store || process.env.LOCAL_DATA_PATH || fileEnvironment.LOCAL_DATA_PATH
  if (!requestedStore) throw new Error('Select the existing store with LOCAL_DATA_PATH or --store.')
  const store = requireDedicatedAbsolute(requestedStore, 'Store')
  if (path.extname(store).toLowerCase() !== '.json') throw new Error('The existing store must be a JSON file.')
  const entry = await fs.lstat(store)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Refusing a missing, replaced or symlinked store.')
  const credentialDirectory = requireDedicatedAbsolute(options.credentialsDirectory || path.join(taskDirectory, 'credentials'), 'Credentials directory')
  const repository = await fs.realpath(process.cwd())
  requireOutsideRepository(repository, credentialDirectory)
  const lock = `${store}.lock`
  try { await fs.mkdir(lock) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Local store is busy. Retry after the app transaction finishes; do not remove its lock.')
    throw error
  }
  const transactionId = randomUUID()
  const temporaryStore = path.join(path.dirname(store), `.bulla-staff-${transactionId}.json`)
  let wroteTemporary = false
  try {
    const snapshot = JSON.parse(await fs.readFile(store, 'utf8'))
    const plan = planStaffChange(snapshot, options)
    const summary = { status: plan.status, role: plan.role, email: plan.email, userId: plan.userId, store, credentialFile: null, backupFile: null }
    if (plan.status === 'unchanged') return summary
    if (!options.apply) return { ...summary, status: 'dry-run', proposedStatus: plan.status }
    await fs.mkdir(credentialDirectory, { recursive: true })
    requireOutsideRepository(repository, await fs.realpath(credentialDirectory))
    let credentialFile = null
    if (plan.password) {
      credentialFile = path.join(credentialDirectory, `${plan.role}-${transactionId}.txt`)
      await fs.writeFile(credentialFile, [
        'Bulla — private local staff credentials',
        `Email: ${plan.email}`, `Password: ${plan.password}`, `Role: ${plan.role}`,
        `Created: ${new Date().toISOString()}`, '',
        'Sign in at http://127.0.0.1:3000/login, then open /admin.',
        'Keep this file private and outside synced/shared folders.',
        'Store the password in your password manager. Never paste it into chat or Git.',
        'This grants local preview access only, not Supabase/hosted staff access.', '',
      ].join('\n'), { flag: 'wx', mode: 0o600 })
    }
    const backupFile = path.join(credentialDirectory, `store-before-staff-${transactionId}.json`)
    await fs.copyFile(store, backupFile, constants.COPYFILE_EXCL)
    await fs.writeFile(temporaryStore, JSON.stringify(plan.next, null, 2), { flag: 'wx', mode: 0o600 })
    wroteTemporary = true
    await fs.rename(temporaryStore, store)
    wroteTemporary = false
    return { ...summary, credentialFile, backupFile }
  } finally {
    if (wroteTemporary) await fs.unlink(temporaryStore)
    await fs.rmdir(lock)
  }
}

function parseArguments(args) {
  const options = {}
  const values = { role: 'role', email: 'email', username: 'username', 'display-name': 'displayName', store: 'store', 'credentials-dir': 'credentialsDirectory' }
  const booleans = { apply: 'apply', reset: 'reset', 'grant-existing': 'grantExisting' }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].replace(/^--/, '')
    if (!args[index].startsWith('--') || !(flag in values || flag in booleans)) throw new Error('Unknown staff-provisioning option.')
    if (flag in booleans) options[booleans[flag]] = true
    else {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${flag}.`)
      options[values[flag]] = value
    }
  }
  return options
}

export async function main(args = process.argv.slice(2)) {
  const result = await provisionLocalStaff(parseArguments(args))
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'dry-run') console.log('No data changed. Add --apply to provision this local staff account.')
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
