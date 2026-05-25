import { auditCacheRisk } from './cache-audit.js'

const changedFiles = process.argv.slice(2)
const report = auditCacheRisk({ changedFiles })

for (const finding of report.findings) {
  console.log(`${finding.level.toUpperCase()} ${finding.file} ${finding.reason}`)
}
console.log(`OVERALL ${report.level.toUpperCase()}`)
