#!/usr/bin/env node
// Compatibility entry point. Preserves the configured store, distinguishes an
// account from its staff role, and defaults to a dry run.
import { main } from '../bulla/local-staff.mjs'

main(['--role', 'admin', ...process.argv.slice(2)]).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
