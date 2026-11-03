/** Curated directory references, not proof of a student's affiliation. */
export type DepartmentOption = {
  id: string
  university_id: string
  name: string
}

export type DepartmentReference = DepartmentOption & { is_verified: boolean }

export function approvedDepartmentOptions(
  references: readonly DepartmentReference[],
  universityId: string,
): DepartmentOption[] {
  return references
    .filter((row) => row.university_id === universityId && row.is_verified === true)
    .map(({ id, university_id, name }) => ({ id, university_id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

type DepartmentChange =
  | { ok: false; message: string }
  | {
      ok: true
      /** Undefined preserves an old client's department; null explicitly clears. */
      departmentId: string | null | undefined
      departmentName?: string | null
      clearProgram: boolean
    }

/** Shared local/cloud write contract. Never match degree or legacy text to an ID. */
export function planDepartmentChange({
  currentUniversityId,
  currentDepartmentId,
  universityId,
  departmentId,
  reference,
}: {
  currentUniversityId: string | null
  currentDepartmentId: string | null | undefined
  universityId: string | null
  departmentId: string | null | undefined
  reference?: DepartmentReference | null
}): DepartmentChange {
  if (departmentId === undefined) {
    if (currentDepartmentId && currentUniversityId !== universityId) {
      return {
        ok: false,
        message: 'Your university changed. Choose a department for the new university or explicitly clear it.',
      }
    }
    return { ok: true, departmentId: undefined, clearProgram: false }
  }

  if (departmentId === null) {
    return {
      ok: true,
      departmentId: null,
      departmentName: null,
      clearProgram: currentDepartmentId != null,
    }
  }

  if (!universityId || !reference || reference.id !== departmentId ||
    reference.university_id !== universityId || reference.is_verified !== true) {
    return {
      ok: false,
      message: 'Choose an approved department from the list for your university, or leave it blank.',
    }
  }

  return {
    ok: true,
    departmentId: reference.id,
    departmentName: reference.name,
    clearProgram: currentDepartmentId !== reference.id,
  }
}
