/**
 * Irreversible side-effect classifier for bash commands.
 *
 * The B2 rollback restores FILES via git. But a shell command's effects are not
 * limited to file writes — it can POST to an API, DELETE rows in a database,
 * publish a package, push to a remote, or spin up infrastructure. None of those
 * are reachable by `git checkout`. Rather than let rollback silently imply a
 * clean undo, we classify the command at capture time and record which classes
 * of irreversible effect it *may* have caused, so the rollback preview/result
 * can state plainly: "these effects cannot be reverted."
 *
 * Conservative by design: we only flag clear external/destructive verbs. False
 * negatives (missing an exotic tool) are acceptable; the point is to stop
 * pretending file rollback == full rollback, not to enumerate every tool.
 */

export interface EffectRule {
  /** Stable category id. */
  id: string
  /** Human-readable caveat shown to the user. */
  label: string
  /** Matches the (whole) command string. */
  test: RegExp
}

/**
 * Ordered rules. A command may match several; we return each distinct label.
 * Patterns are intentionally anchored on the *verb*, not just the tool, so e.g.
 * `psql -c 'SELECT ...'` (read-only) does not trip the database-write rule.
 */
const EFFECT_RULES: EffectRule[] = [
  {
    id: 'network-write',
    label: 'outbound network mutation (HTTP POST/PUT/PATCH/DELETE — remote state may have changed)',
    // curl with a mutating method or body; httpie with a mutating verb; wget --post
    test: /\bcurl\b[^\n|;&]*?(-X\s*(POST|PUT|PATCH|DELETE)|--request\s*(POST|PUT|PATCH|DELETE)|--data\b|--data-\w+\b|-d\s|-T\s|--upload-file\b)|\bhttp(ie)?\b[^\n|;&]*\b(POST|PUT|PATCH|DELETE)\b|\bwget\b[^\n|;&]*(--post-data|--post-file|--method=(POST|PUT|PATCH|DELETE))/i,
  },
  {
    id: 'database-write',
    label: 'database write (SQL/Redis/Mongo mutation — rows/keys may have changed)',
    test: /\b(psql|mysql|mariadb|sqlite3|mongosh?|cqlsh|clickhouse-client)\b[^\n]*\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|CREATE|ALTER|UPSERT|REPLACE)\b|\bredis-cli\b[^\n]*\b(SET|DEL|FLUSHALL|FLUSHDB|HSET|LPUSH|RPUSH|EXPIRE|RENAME)\b/i,
  },
  {
    id: 'package-publish',
    label: 'package/release publish (artifact pushed to a registry — cannot be unpublished cleanly)',
    test: /\b(npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b|\bpoetry\s+publish\b|\bgh\s+release\s+create\b|\bdotnet\s+nuget\s+push\b/i,
  },
  {
    id: 'vcs-push',
    label: 'remote VCS mutation (git push / PR merge — pushed history is hard to retract)',
    test: /\bgit\s+push\b|\bgh\s+pr\s+merge\b|\bgit\s+push\s+--tags\b/i,
  },
  {
    id: 'infra-mutation',
    label: 'container/cloud infrastructure mutation (containers, clusters or cloud resources changed)',
    test: /\bdocker\s+(push|run|rm|rmi|volume\s+rm|system\s+prune)\b|\bkubectl\s+(apply|delete|create|replace|scale|rollout)\b|\bterraform\s+(apply|destroy)\b|\bhelm\s+(install|upgrade|uninstall|delete)\b|\b(aws|gcloud|az)\s+\w+[^\n]*\b(create|delete|put|update|terminate|deploy|rm)\b/i,
  },
  {
    id: 'service-control',
    label: 'system service / daemon control (a background process or service state changed)',
    test: /\b(systemctl|service)\s+(start|stop|restart|enable|disable|reload)\b|\blaunchctl\s+(load|unload|bootstrap|bootout)\b|\bpm2\s+(start|stop|restart|delete)\b|\b(brew\s+services)\s+(start|stop|restart)\b/i,
  },
]

/**
 * Classify a bash command, returning the labels of every irreversible
 * effect class it appears to trigger. Empty array = no recognized
 * non-filesystem side effect (file-only changes are fully revertable).
 */
export function classifyIrreversibleEffects(command: string): string[] {
  if (!command || typeof command !== 'string') return []
  const labels: string[] = []
  for (const rule of EFFECT_RULES) {
    if (rule.test.test(command)) labels.push(rule.label)
  }
  return labels
}

/** Stable category ids matched (for telemetry/dedup), parallel to labels. */
export function classifyIrreversibleEffectIds(command: string): string[] {
  if (!command || typeof command !== 'string') return []
  return EFFECT_RULES.filter(r => r.test.test(command)).map(r => r.id)
}
