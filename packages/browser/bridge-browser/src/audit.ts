/**
 * `bridge-browser` audit and egress-policy layer for sensitive intranets.
 *
 * Two waterfall listeners, both opt-in via `Config.audit`:
 *
 * 1. `tools/post-execute` writes one JSONL line per completed tool call to
 *    `auditDir/<date>.jsonl`. The record carries metadata only — timestamp,
 *    session id, tool name, and the URL host when the arguments carried a
 *    URL. Arguments, page text, snapshot content, and result bodies are never
 *    written, so the audit trail stays reviewable without leaking content.
 * 2. `tools/pre-execute` gates `browser_navigate` on an allowlist of hosts,
 *    and gates MCP tools on an allowlist of server-name prefixes. A denied
 *    call returns a denial reason to the model; nothing is executed.
 *
 * The listeners delegate through `next()` and are effect-scoped, so HMR
 * behaves like the rest of the bridge.
 *
 * @module @yuxianglin/dsh-bridge-browser/audit
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, PostToolDecision, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

/** Audit-layer tunables; all optional so an unconfigured install runs silently. */
export interface AuditConfig {
  /** Master switch. When false, no listener is registered. Defaults to true. */
  enabled?: boolean
  /** Directory for `<date>.jsonl` audit files. Defaults to `~/.dsh/audit`. */
  auditDir?: string
  /** Host allowlist for `browser_navigate`/`browser_get_text` URL arguments. */
  allowedHosts?: string[]
  /**
   * MCP tool allowlist as `serverName` prefixes of the raw tool name. A tool
   * `mcp__atlassian__jira_search` passes when the list contains `atlassian`.
   * Empty or undefined denies every `mcp__*` call.
   */
  mcpAllow?: string[]
}

/** Tool names that carry a URL in `arguments.url` (see bridge tools.ts). */
const URL_CARRYING_TOOLS = new Set(['browser_navigate', 'browser_get_text'])

/** Match a URL's host with a hostname pattern: exact, `.`-prefixed suffix, or `*`. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('.')) return host.endsWith(pattern) || host === pattern.slice(1)
  return host === pattern
}

/** Extract the host of `arguments.url`, or undefined when absent/invalid. */
function urlHost(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const url = (args as { url?: unknown }).url
  if (typeof url !== 'string') return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * Install the audit and egress-policy listeners, effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - resolved audit configuration; `enabled: false` no-ops.
 */
export function installAudit(ctx: Context, config: AuditConfig): void {
  if (config.enabled === false) return
  const auditDir = config.auditDir ?? join(process.env.HOME ?? '.', '.dsh', 'audit')
  const allowedHosts = config.allowedHosts ?? []
  const mcpAllow = config.mcpAllow ?? []
  ctx.effect(() => {
    const disposers: Array<() => unknown> = []
    disposers.push(ctx.on('tools/post-execute', (exec: ToolExecution, _result: unknown, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
      // Delegate first so the call's outcome is never altered by audit failure;
      // then record, best-effort, after the decision settles.
      return next().then(async (decision) => {
        const host = URL_CARRYING_TOOLS.has(exec.name) ? urlHost(exec.arguments) : undefined
        const line = JSON.stringify({
          time: new Date().toISOString(),
          session: exec.agent?.id,
          tool: exec.name,
          host,
          denied: decision.kind !== 'accept',
        })
        try {
          const date = new Date().toISOString().slice(0, 10)
          await mkdir(auditDir, { recursive: true })
          await appendFile(join(auditDir, `${date}.jsonl`), line + '\n')
        } catch {
          ctx.logger.warn('bridge-browser audit: failed to append audit line')
        }
        return decision
      })
    }))
    disposers.push(ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      if (exec.name.startsWith('mcp__')) {
        const server = exec.name.slice('mcp__'.length).split('__', 1)[0]
        if (server !== undefined && mcpAllow.includes(server)) return next()
        return Promise.resolve({ kind: 'deny', reason: `bridge-browser audit: MCP server "${server ?? exec.name}" is not allowlisted` })
      }
      if (URL_CARRYING_TOOLS.has(exec.name)) {
        const host = urlHost(exec.arguments)
        if (host !== undefined && allowedHosts.some(pattern => hostMatches(pattern, host))) return next()
        return Promise.resolve({ kind: 'deny', reason: `bridge-browser audit: host "${host ?? '(unparseable)'}" is not in the navigation allowlist` })
      }
      return next()
    }))
    return () => { for (const dispose of disposers) dispose() }
  }, 'bridge-browser: audit listeners')
}