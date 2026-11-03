'use server'

import { revalidatePath } from 'next/cache'
import {
  enrollStaffAuthenticator,
  verifyStaffAuthenticator,
} from './staff-mfa'
import type { StaffMfaActionState, StaffMfaEnrollmentResult } from './staff-mfa-state'

// No previous action state is accepted: the setup QR must never be posted back.
export async function enrollStaffMfaAction(formData: FormData): Promise<StaffMfaEnrollmentResult> {
  const result = await enrollStaffAuthenticator({ friendlyName: formData.get('friendlyName') })
  revalidatePath('/settings/security')
  return result
}

export async function verifyStaffMfaAction(formData: FormData): Promise<StaffMfaActionState> {
  const result = await verifyStaffAuthenticator({
    factorId: formData.get('factorId'), code: formData.get('code'),
  })
  revalidatePath('/settings/security')
  return result
}

