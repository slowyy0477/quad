'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input, Select } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { enrollStaffMfaAction, verifyStaffMfaAction } from '../staff-mfa-actions'
import { emptyStaffMfaState, type StaffMfaActionState, type StaffMfaFactor } from '../staff-mfa-state'

type SetupQR = { factorId: string; qrCode: string }

/** QR material stays only in this transient render state, never in action prevState. */
export function StaffMfaForm({
  factors,
  canEnroll,
}: { factors: StaffMfaFactor[]; canEnroll: boolean }) {
  const [setup, setSetup] = useState<SetupQR | null>(null)
  const [state, action, pending] = useActionState(
    async (_previous: StaffMfaActionState, formData: FormData): Promise<StaffMfaActionState> => {
      try {
        if (formData.get('intent') === 'enroll') {
          const result = await enrollStaffMfaAction(formData)
          if (result.status === 'enrolled') {
            setSetup({ factorId: result.factorId, qrCode: result.qrCode })
            return emptyStaffMfaState
          }
          return result
        }
        const result = await verifyStaffMfaAction(formData)
        if (result.status === 'verified' || result.status === 'verified_unassured') setSetup(null)
        return result
      } catch {
        return { status: 'error', message: 'The request was not confirmed. Refresh account security before trying again; a provider-side change may already have completed.' }
      }
    },
    emptyStaffMfaState,
  )
  const selectable = factors.filter(factor => factor.status === 'verified' || canEnroll)
  const hasVerified = factors.some(factor => factor.status === 'verified')
  const tone = state.status === 'verified' ? 'success' : state.status === 'verified_unassured' ? 'warning' : 'danger'
  const codeField = (
    <Field id="staff-mfa-code" label="Authenticator code"
      hint="Enter the current six-digit code. Your device clock should be set automatically."
      error={state.fieldErrors?.code} required>
      {(field) => (
        <Input {...field} name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
          autoCapitalize="none" spellCheck={false} maxLength={6} pattern="[0-9]{6}" disabled={pending} />
      )}
    </Field>
  )

  return (
    <div className="space-y-6">
      {state.message ? <Alert tone={tone}>{state.message}</Alert> : null}
      {state.status === 'verified' ? (
        <Link href="/admin" prefetch={false} className="inline-flex min-h-11 items-center text-accent-700 underline">
          Continue to staff tools
        </Link>
      ) : null}

      {setup ? (
        <section className="space-y-4" aria-labelledby="staff-mfa-setup-title">
          <h2 id="staff-mfa-setup-title" className="text-xl font-semibold">Finish authenticator setup</h2>
          <p className="text-sm text-ink-muted">
            Scan this private QR with your authenticator app. It contains the setup key—do not share or save a screenshot.
            Setup is not complete until your code is verified.
          </p>
          <div className="w-fit max-w-full rounded bg-white p-3">
            {/* This bounded provider data image must not pass through an image optimizer or injected SVG HTML. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrCode} alt="Private QR for setting up your Bulla authenticator"
              width={256} height={256} className="h-auto max-w-full" referrerPolicy="no-referrer" />
          </div>
          <form action={action} noValidate aria-busy={pending} className="space-y-4">
            <input type="hidden" name="intent" value="verify" />
            <input type="hidden" name="factorId" value={setup.factorId} />
            {state.fieldErrors?.factorId ? <Alert tone="danger">{state.fieldErrors.factorId}</Alert> : null}
            {codeField}
            <SubmitButton variant="primary" block disabled={pending} pendingLabel="Verifying authenticator…">
              Verify and finish setup
            </SubmitButton>
          </form>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setSetup(null)}>
            Hide setup QR
          </Button>
          <p className="text-xs text-ink-muted">
            Hiding the QR does not delete the provider’s unfinished setup. If you scanned it, you can finish with its code below.
            This page cannot display an old setup key again.
          </p>
        </section>
      ) : (
        <>
          {selectable.length ? (
            <section className="space-y-4" aria-labelledby="staff-mfa-verify-title">
              <h2 id="staff-mfa-verify-title" className="text-xl font-semibold">Verify this staff session</h2>
              <form action={action} noValidate aria-busy={pending} className="space-y-4">
                <input type="hidden" name="intent" value="verify" />
                <Field id="staff-mfa-factor" label="Authenticator" error={state.fieldErrors?.factorId} required>
                  {(field) => (
                    <Select {...field} name="factorId" defaultValue={selectable[0].id} disabled={pending}>
                      {selectable.map(factor => (
                        <option key={factor.id} value={factor.id}>
                          {factor.name}{factor.status === 'unverified' ? ' (unfinished setup)' : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {codeField}
                <SubmitButton variant="primary" block disabled={pending} pendingLabel="Verifying authenticator…">
                  Verify staff session
                </SubmitButton>
              </form>
            </section>
          ) : null}

          <section className="space-y-4" aria-labelledby="staff-mfa-enroll-title">
            <h2 id="staff-mfa-enroll-title" className="text-xl font-semibold">
              {hasVerified ? 'Add a backup authenticator' : 'Set up an authenticator app'}
            </h2>
            {canEnroll ? (
              <form action={action} noValidate aria-busy={pending} className="space-y-4">
                <input type="hidden" name="intent" value="enroll" />
                <Field id="staff-mfa-name" label="Authenticator name"
                  hint="Use a distinct name, such as Work phone. Do not enter an authenticator code or setup key."
                  error={state.fieldErrors?.friendlyName} required>
                  {(field) => (
                    <Input {...field} name="friendlyName" defaultValue="Bulla authenticator"
                      autoComplete="off" maxLength={60} disabled={pending} />
                  )}
                </Field>
                <p className="text-sm text-ink-muted">
                  This creates an unfinished TOTP setup with your account provider.
                  Provider availability is checked when you submit. Verified authenticators are not removed by this form.
                </p>
                <SubmitButton block disabled={pending} pendingLabel="Creating private setup…">Create setup QR</SubmitButton>
              </form>
            ) : (
              <Alert tone="info">
                Verify an existing authenticator before adding another. A password sign-in alone cannot replace your second factor.
              </Alert>
            )}
          </section>
        </>
      )}
      <p className="text-xs text-ink-muted">
        Lost your authenticator? Use another enrolled device or contact the operator for an independently verified recovery.
        This screen does not remove verified factors or offer an MFA bypass through password recovery.
      </p>
    </div>
  )
}
