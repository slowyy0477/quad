import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface TempWorkspace {
  readonly directory: string
  cleanup(): Promise<void>
}

function assertInsideRoot(root: string, target: string) {
  const relative = path.relative(root, path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Refusing to clean up a test workspace outside its temporary root')
  }
}

/** Bulla overrides suite-specific legacy roots, then QUAD_TEST_TMP_DIR and the OS default. */
export async function createTempWorkspace(name: string, legacyRoot?: string): Promise<TempWorkspace> {
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) throw new Error('Invalid test workspace name')

  const requestedRoot = process.env.BULLA_TEST_TMP_DIR || legacyRoot || process.env.QUAD_TEST_TMP_DIR || os.tmpdir()
  if (!path.isAbsolute(requestedRoot) || (process.platform === 'win32' && /^[/\\]+$/.test(path.parse(requestedRoot).root))) {
    throw new Error('Test temporary root must be an absolute path (including a drive or UNC share on Windows)')
  }

  await fs.mkdir(path.resolve(requestedRoot), { recursive: true })
  const root = await fs.realpath(path.resolve(requestedRoot))
  const directory = await fs.mkdtemp(path.join(root, `bulla-${name}-`))
  assertInsideRoot(root, directory)
  let removed = false

  return {
    directory,
    async cleanup() {
      if (removed) return
      // Capture absolute paths before cwd/env stubs can change, and never remove the root.
      const target = path.resolve(directory)
      assertInsideRoot(root, target)
      try {
        const entry = await fs.lstat(target)
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error('Refusing to clean up a replaced test workspace')
        }
        const resolvedTarget = await fs.realpath(target)
        assertInsideRoot(root, resolvedTarget)
        if (path.relative(target, resolvedTarget)) {
          throw new Error('Refusing to clean up a relocated test workspace')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        removed = true
        return
      }
      await fs.rm(target, { recursive: true, force: true })
      removed = true
    },
  }
}
