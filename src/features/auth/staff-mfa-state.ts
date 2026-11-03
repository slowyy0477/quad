/** Client-safe MFA view/action data. Never add session tokens, codes or setup keys. */
export type StaffMfaFactor = {
  id: string
  name: string
  status: 'verified' | 'unverified'
}

export type StaffMfaSettings =
  | { state: 'signed_out' | 'unavailable' | 'not_staff' | 'local_unsupported' }
  | {
      state: 'cloud'
      assured: boolean
      assuranceUnavailable: boolean
      canEnroll: boolean
      factors: StaffMfaFactor[]
      hasOtherFactors: boolean
    }

export type StaffMfaActionState = {
  status: 'idle' | 'error' | 'verified' | 'verified_unassured'
  message?: string
  fieldErrors?: Partial<Record<'friendlyName' | 'factorId' | 'code', string>>
}

export type StaffMfaEnrollmentResult =
  | { status: 'enrolled'; factorId: string; qrCode: string }
  | StaffMfaActionState

export const emptyStaffMfaState: StaffMfaActionState = { status: 'idle' }
