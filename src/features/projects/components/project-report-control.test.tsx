import { act } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectReportControl } from './project-report-control'

vi.mock('@/features/moderation/actions', () => ({ submitReportAction: vi.fn() }))

let hydrationRoot: Root | null = null
let hydrationContainer: HTMLDivElement | null = null

beforeEach(() => {
  // JSDOM has no layout observer. Real sizing remains a browser assertion.
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  })
})

afterEach(async () => {
  if (hydrationRoot) await act(async () => hydrationRoot?.unmount())
  hydrationRoot = null
  hydrationContainer?.remove()
  hydrationContainer = null
  cleanup()
  vi.unstubAllGlobals()
})

describe('client-owned project report trigger', () => {
  it('opens the real dialog with the exact project target and returns focus on cancel', async () => {
    const user = userEvent.setup()
    render(<ProjectReportControl projectId="prj_report_target" />)
    const trigger = screen.getByRole('button', { name: 'Report this project' })
    expect(trigger).toHaveAttribute('type', 'button')
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Report this project' })).toBeVisible()
    expect(document.querySelector('input[name="kind"]')).toHaveValue('project')
    expect(document.querySelector('input[name="targetId"]')).toHaveValue('prj_report_target')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('prerenders the host button and hydrates it without replacing the surrounding tree', async () => {
    const component = <ProjectReportControl projectId="prj_hydration_target" />
    hydrationContainer = document.createElement('div')
    hydrationContainer.innerHTML = renderToString(component)
    document.body.append(hydrationContainer)
    const initialButton = hydrationContainer.querySelector('button')
    expect(initialButton).not.toBeNull()
    expect(initialButton).toHaveAttribute('aria-label', 'Report this project')
    const recovered: unknown[] = []
    await act(async () => {
      hydrationRoot = hydrateRoot(hydrationContainer!, component, {
        onRecoverableError: (error) => recovered.push(error),
      })
    })
    expect(recovered).toEqual([])
    expect(hydrationContainer.querySelector('button')).toBe(initialButton)
    await userEvent.setup().click(initialButton!)
    expect(screen.getByRole('dialog', { name: 'Report this project' })).toBeVisible()
  })
})
