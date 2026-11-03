/**
 * Inspect generated manifests/client chunks without reading private source data.
 * A nonempty server-only canary must be supplied during the preceding build.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const [distRoot, reportPath] = process.argv.slice(2)
const canary = process.env.BULLA_BUILD_SECRET_CANARY
if (!distRoot || !reportPath || !path.isAbsolute(distRoot) || !path.isAbsolute(reportPath)) {
  throw new Error('Usage: check-build.mjs <absolute-dist-directory> <absolute-new-report.md>')
}
if (!canary || canary.length < 24) throw new Error('A nonempty build secret canary is required.')
if (path.extname(reportPath) !== '.md') throw new Error('The evidence report must be Markdown.')

async function filesIn(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesIn(filename))
    else if (entry.isFile()) files.push(filename)
    // Never follow nested links into another checkout or the dependency tree.
  }
  return files
}
const files = await filesIn(distRoot)
const manifests = files.filter(filename => filename.endsWith('.nft.json'))
const staticRoot = path.join(distRoot, 'static')
const clientFiles = files.filter(filename => {
  const relative = path.relative(staticRoot, filename)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) && /\.(?:js|mjs|json|map)$/.test(filename)
})
const privateEntries = []
for (const filename of manifests) {
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
  for (const entry of manifest.files ?? []) {
    const normalized = entry.replaceAll('\\', '/')
    if (/(?:^|\/)\.env(?:\.[^/]+)?$/.test(normalized) ||
        /(?:^|\/)data\/local\.json(?:\.[^/]*)?$/.test(normalized) ||
        (/(?:^|\/)(?:credentials|\.scratch|\.claude)\//.test(normalized) &&
          !normalized.includes('/node_modules/'))) {
      privateEntries.push({ manifest: path.relative(distRoot, filename), entry: normalized })
    }
  }
}
let clientCanaryMatches = 0
for (const filename of clientFiles) {
  if ((await fs.readFile(filename, 'utf8')).includes(canary)) clientCanaryMatches += 1
}
const passed = manifests.length > 0 && clientFiles.length > 0 &&
  privateEntries.length === 0 && clientCanaryMatches === 0
const report = [
  '# Bulla — deployment artifact privacy check', '',
  `Result: ${passed ? 'Passed' : 'Failed'}`, '',
  `Build directory: \`${distRoot}\``, '',
  '| Check | Result |', '| --- | --- |',
  `| Deployment trace manifests inspected | ${manifests.length} |`,
  `| Client chunk/map files inspected | ${clientFiles.length} |`,
  `| App-owned private file entries | ${privateEntries.length} |`,
  `| Nonempty server-key canary matches in client output | ${clientCanaryMatches} |`,
  '', 'Both inventories must be nonempty to pass. The canary value is not recorded.', '',
  ...(privateEntries.length ? ['## Refused private trace entries', '',
    ...privateEntries.map(match => `- \`${match.manifest}\` includes \`${match.entry}\`.`), ''] : []),
  '## Limits and next action', '',
  'This checks the known app-owned private paths and a fake server-key marker.',
  'It does not certify all possible secrets, hosted permissions, storage, recovery',
  'or capacity. Never deploy the private JSON adapter or include real local data.',
  'Next: resolve any failed artifact check; otherwise continue the launch gates',
  'in `docs/bulla/ISSUES.md` and record this evidence in the recovery checkpoint.', '',
].join('\n')
await fs.mkdir(path.dirname(reportPath), { recursive: true })
await fs.writeFile(reportPath, report, { flag: 'wx' })
console.log(`Bulla build privacy: ${passed ? 'passed' : 'FAILED'}; ${manifests.length} manifests, ${clientFiles.length} client files. Report: ${reportPath}`)
if (!passed) process.exitCode = 1
