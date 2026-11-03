import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => ({
  configured: true, user: { id: '11111111-1111-4111-8111-111111111111' } as { id: string } | null,
  rpc: vi.fn(), from: vi.fn(), revalidate: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => false }))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: () => provider.configured }))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => provider.user,
  createClient: async () => ({ rpc: provider.rpc, from: provider.from }),
}))
vi.mock('next/cache', () => ({ revalidatePath: provider.revalidate }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { respondToProjectInviteAction } from '@/features/projects/invite-actions'
import { listMyProjectInvitations } from '@/features/projects/invitations'
import { convertIdeaToProjectAction } from '@/features/ideas/actions'

const inviteId = '22222222-2222-4222-8222-222222222222'
const projectId = '33333333-3333-4333-8333-333333333333'
const ideaId = '44444444-4444-4444-8444-444444444444'
function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}
beforeEach(() => {
  provider.configured = true
  provider.user = { id: '11111111-1111-4111-8111-111111111111' }
  provider.rpc.mockReset()
  provider.from.mockReset()
  provider.revalidate.mockReset()
})

describe('cloud invitation action and query contracts', () => {
  it('sends only the invitation reference and response, ignoring forged identity/role/project', async () => {
    provider.rpc.mockResolvedValue({ data: [{ project_id: projectId, project_slug: 'real-project', status: 'accepted' }], error: null })
    expect(await respondToProjectInviteAction({ status: 'idle' }, form({
      inviteId, response: 'accepted', inviteeId: projectId, userId: projectId, role: 'owner', projectId: ideaId,
    }))).toMatchObject({ status: 'success', response: 'accepted', projectPath: '/projects/real-project' })
    expect(provider.rpc).toHaveBeenCalledExactlyOnceWith('respond_to_project_invite', { p_invite_id: inviteId, p_response: 'accepted' })
    expect(provider.from).not.toHaveBeenCalled()
  })

  it('refuses signed-out, unconfigured, local-style ID and forged decisions without calling the provider', async () => {
    provider.configured = false
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId, response: 'accepted' }))).status).toBe('error')
    provider.configured = true
    provider.user = null
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId, response: 'accepted' }))).status).toBe('error')
    provider.user = { id: projectId }
    for (const values of [{ inviteId: 'pin_local', response: 'accepted' }, { inviteId, response: 'revoked' }]) {
      expect((await respondToProjectInviteAction({ status: 'idle' }, form(values))).status).toBe('error')
    }
    expect(provider.rpc).not.toHaveBeenCalled()
  })

  it('reports an unavailable migration and sanitizes private provider failures without raw logging', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      provider.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Private provider diagnostic.', details: 'private note' } })
      const missing = await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId, response: 'accepted' }))
      expect(missing.message).toMatch(/database update/)
      expect(JSON.stringify(missing)).not.toContain('Private provider')
      provider.rpc.mockRejectedValue(new Error('Private provider diagnostic.'))
      expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId, response: 'declined' }))).status).toBe('error')
      expect(logger).not.toHaveBeenCalled()
    } finally { logger.mockRestore() }
  })

  it('does not claim membership or revalidate success when a zero-row or malformed/unsafe slug response arrives', async () => {
    for (const data of [[], [{ project_id: projectId, project_slug: '//evil.test', status: 'accepted' }]]) {
      provider.rpc.mockResolvedValue({ data, error: null })
      expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId, response: 'accepted' }))).status).toBe('error')
    }
    expect(provider.revalidate).not.toHaveBeenCalled()
  })

  it('accepts a confirmed declined private-project response without inventing a project link', async () => {
    provider.rpc.mockResolvedValue({ data: [{ project_id: projectId, project_slug: null, status: 'declined' }], error: null })
    const result = await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId, response: 'declined' }))
    expect(result).toMatchObject({ status: 'success', response: 'declined' })
    expect(result.projectPath).toBeUndefined()
  })

  it('projects only the minimal own-invitation DTO and rejects inconsistent provider assurance of availability', async () => {
    const row = {
      invite_id: inviteId, project_id: projectId, project_slug: 'private-project',
      project_title: 'Private project', project_visibility: 'private', message: 'Own invitation note.',
      proposed_role: null, created_at: '2026-10-20T00:00:00.000Z', can_accept: true, refusal_reason: null,
      description: 'Do not expose private project body.', invitee_id: provider.user!.id, inviter_id: ideaId,
    }
    provider.rpc.mockResolvedValue({ data: [row], error: null })
    const result = await listMyProjectInvitations({ limit: 1 })
    expect(result.invitations[0]).toMatchObject({ id: inviteId, message: 'Own invitation note.' })
    for (const field of ['description', 'invitee_id', 'inviter_id']) expect(result.invitations[0]).not.toHaveProperty(field)
    expect(provider.rpc).toHaveBeenCalledWith('project_invitation_inbox', {
      p_project_slug: null, p_limit: 2, p_before_at: null, p_before_id: null,
    })
    provider.rpc.mockResolvedValue({ data: [{ ...row, can_accept: false }], error: null })
    expect((await listMyProjectInvitations()).invitations).toEqual([])
  })

  it('uses one atomic conversion RPC instead of an interest read and partial insertion loop', async () => {
    provider.rpc.mockResolvedValue({ data: [{ project_id: projectId, project_slug: 'real-project', invited_count: 2 }], error: null })
    await expect(convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId }))).rejects.toThrow(/real-project\?converted=1&invited=2/)
    expect(provider.rpc).toHaveBeenCalledExactlyOnceWith('convert_idea_to_project_with_invites', { p_idea_id: ideaId })
    expect(provider.from).not.toHaveBeenCalled()
  })

  it('does not report conversion success for a missing RPC, transport failure or invalid count', async () => {
    provider.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    expect((await convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId }))).message).toMatch(/database update/)
    provider.rpc.mockRejectedValue(new Error('Provider transport detail must not escape.'))
    expect((await convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId }))).status).toBe('error')
    provider.rpc.mockResolvedValue({ data: [{ project_id: projectId, project_slug: 'real-project', invited_count: 1000 }], error: null })
    expect((await convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId }))).status).toBe('error')
  })
})
