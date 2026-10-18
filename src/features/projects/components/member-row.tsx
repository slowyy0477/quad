'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { Select } from '@/components/ui/input'
import { changeMemberRoleAction, removeMemberAction, transferOwnershipAction } from '@/features/projects/actions'
import { emptyFormState } from '@/lib/form-state'
import type { ProjectMember } from '@/features/projects/queries'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  maintainer: 'Maintainer',
  member: 'Member',
}

/**
 * One member of the project, with the controls the reader is allowed to use.
 *
 * Three separate actions, and each is destructive enough to need its own account:
 * changing a role, removing someone, and transferring ownership. The last two sit
 * behind a confirm dialog whose title names the project and whose body states the
 * consequence, because "Remove" and "Make owner" are not reversible by the person who
 * clicks them.
 *
 * Nothing is hidden by a permission check in the interface. Which controls render
 * decides what is *offered*; every write is refused or accepted by the policies again,
 * so a stale prop here produces an error message, never a privilege.
 */
export function MemberRow({
  member,
  projectId,
  projectTitle,
  slug,
  viewerId,
  viewerIsOwner,
  canManage,
}: {
  member: ProjectMember
  projectId: string
  projectTitle: string
  slug: string
  viewerId: string | null
  viewerIsOwner: boolean
  canManage: boolean
}) {
  const [roleState, roleAction] = useActionState(changeMemberRoleAction, emptyFormState)
  const [removeState, removeAction] = useActionState(removeMemberAction, emptyFormState)
  const [transferState, transferAction] = useActionState(transferOwnershipAction, emptyFormState)

  const profile = member.profile
  const isOwnerRow = member.role === 'owner'
  const isSelf = profile?.id === viewerId
  const name = profile?.display_name ?? 'A former member'

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={name} src={profile?.avatar_url ?? null} size="sm" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {profile ? (
              <Link
                href={`/u/${profile.username}`}
                className="text-sm font-medium text-ink underline-offset-2 hover:underline"
              >
                {name}
              </Link>
            ) : (
              <span className="text-sm font-medium text-ink-muted">{name}</span>
            )}
            <Badge tone={isOwnerRow ? 'accent' : 'neutral'}>{ROLE_LABEL[member.role] ?? member.role}</Badge>
            {member.title ? <span className="text-xs text-ink-faint">{member.title}</span> : null}
          </div>
          {profile?.headline ? <p className="mt-0.5 text-xs text-ink-muted">{profile.headline}</p> : null}
        </div>
      </div>

      {canManage && !isOwnerRow ? (
        <div className="flex flex-col items-end gap-2">
          <form action={roleAction} className="flex items-center gap-2">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="profileId" value={profile?.id ?? ''} />
            <label className="sr-only" htmlFor={`role-${profile?.id}`}>
              Role for {name}
            </label>
            <Select
              id={`role-${profile?.id}`}
              name="role"
              defaultValue={member.role}
              className="min-h-8 w-auto py-1 text-xs"
            >
              <option value="member">Member</option>
              <option value="maintainer">Maintainer</option>
            </Select>
            <Button type="submit" size="sm" variant="secondary">
              Save role
            </Button>
          </form>

          <div className="flex flex-wrap justify-end gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" variant="ghost">
                  Remove
                </Button>
              </DialogTrigger>
              <DialogContent
                title={`Remove ${name} from ${projectTitle}?`}
                description="They lose access to the project immediately. Their work and posts stay."
              >
                <form action={removeAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="profileId" value={profile?.id ?? ''} />
                  {removeState.status === 'error' && removeState.message ? (
                    <Alert tone="danger">{removeState.message}</Alert>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="secondary">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit" variant="danger">
                      Remove {name}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            {viewerIsOwner && !isSelf ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" variant="ghost">
                    Make owner
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title={`Make ${name} the owner of ${projectTitle}?`}
                  description={`${name} becomes the owner and can manage everyone, including you. You stay on the project as a maintainer. This is the only way ownership moves; it cannot be undone by you afterwards.`}
                >
                  <form action={transferAction} className="space-y-3">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="profileId" value={profile?.id ?? ''} />
                    {transferState.status === 'error' && transferState.message ? (
                      <Alert tone="danger">{transferState.message}</Alert>
                    ) : null}
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button type="button" variant="secondary">
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button type="submit" variant="primary">
                        Transfer ownership to {name}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>

          {roleState.status === 'error' && roleState.message ? (
            <p role="alert" className="text-xs font-medium text-danger-600">
              {roleState.message}
            </p>
          ) : null}
          {roleState.status === 'success' && roleState.message ? (
            <p role="status" className="text-xs text-ink-muted">
              {roleState.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
