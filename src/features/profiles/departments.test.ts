import { describe, expect, it } from 'vitest'
import { approvedDepartmentOptions, planDepartmentChange } from './departments'
import {
  onboardingSchema, profileEditSchema, localOnboardingSchema, localProfileEditSchema,
} from './schemas'

const campus = '11111111-1111-4111-8111-111111111111'
const department = '22222222-2222-4222-8222-222222222222'
const input = { username: 'synthetic_student', displayName: 'Synthetic Student', universityId: campus, visibility: 'private' }

describe('department input is an explicit, provider-specific selection', () => {
  it.each([onboardingSchema, profileEditSchema, localOnboardingSchema, localProfileEditSchema])(
    'distinguishes omitted, blank and selected department values',
    (schema) => {
      expect(schema.parse(input).departmentId).toBeUndefined()
      expect(schema.parse({ ...input, departmentId: '  ' }).departmentId).toBeNull()
      expect(schema.parse({ ...input, departmentId: ` ${department} ` }).departmentId).toBe(department)
      expect(schema.parse({ ...input, degree: 'Computer Science' }).departmentId).toBeUndefined()
    },
  )

  it.each([onboardingSchema, profileEditSchema])('keeps cloud department UUID validation strict', (schema) => {
    for (const departmentId of ['dept_one', '../local.json', 'Computer Science', new Blob(['not an ID'])]) {
      expect(schema.safeParse({ ...input, departmentId }).success).toBe(false)
    }
  })

  it.each([localOnboardingSchema, localProfileEditSchema])('accepts only bounded, safe local reference IDs', (schema) => {
    expect(schema.parse({ ...input, departmentId: ' dept_one ' }).departmentId).toBe('dept_one')
    for (const departmentId of ['../local.json', 'Computer Science', 'x'.repeat(129)]) {
      expect(schema.safeParse({ ...input, departmentId }).success).toBe(false)
    }
  })
})

describe('department reference and legacy write contract', () => {
  const reference = { id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems', is_verified: true }
  const current = {
    currentUniversityId: 'uni_one', currentDepartmentId: 'dept_one', universityId: 'uni_one',
  }

  it('offers only curated references of the exact university, in name order', () => {
    expect(approvedDepartmentOptions([
      reference,
      { ...reference, id: 'dept_second', name: 'Arts' },
      { ...reference, id: 'dept_other', university_id: 'uni_two' },
      { ...reference, id: 'dept_pending', is_verified: false },
    ], 'uni_one')).toEqual([
      { id: 'dept_second', university_id: 'uni_one', name: 'Arts' },
      { id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems' },
    ])
  })

  it('does not clear an omitted department or linked program on the same campus', () => {
    expect(planDepartmentChange({ ...current, departmentId: undefined })).toEqual({
      ok: true, departmentId: undefined, clearProgram: false,
    })
  })

  it('refuses to carry a scoped old FK across campuses without explicit consent', () => {
    expect(planDepartmentChange({ ...current, universityId: 'uni_two', departmentId: undefined }))
      .toMatchObject({ ok: false, message: expect.stringContaining('explicitly clear') })
    // A text-only legacy affiliation has no FK. Omission must still preserve it.
    expect(planDepartmentChange({
      ...current, currentDepartmentId: undefined, universityId: 'uni_two', departmentId: undefined,
    })).toMatchObject({ ok: true, departmentId: undefined, clearProgram: false })
  })

  it('clears a department explicitly and invalidates only its linked program', () => {
    expect(planDepartmentChange({ ...current, departmentId: null })).toEqual({
      ok: true, departmentId: null, departmentName: null, clearProgram: true,
    })
  })

  it('keeps a linked program when the same department is explicitly selected', () => {
    expect(planDepartmentChange({ ...current, departmentId: reference.id, reference }))
      .toMatchObject({ ok: true, departmentId: reference.id, clearProgram: false })
  })

  it.each([
    { universityId: null, reference },
    { universityId: 'uni_two', reference },
    { universityId: 'uni_one', reference: { ...reference, is_verified: false } },
    { universityId: 'uni_one', reference: null },
  ])('refuses missing, uncurated or cross-campus references', (invalid) => {
    expect(planDepartmentChange({ ...current, departmentId: reference.id, ...invalid }))
      .toMatchObject({ ok: false })
  })
})
