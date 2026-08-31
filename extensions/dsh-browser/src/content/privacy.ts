/**
 * Privacy boundary for page snapshots: sensitive form fields are never echoed.
 *
 * DeepSeek models are text-only and the whole bridge is text-only, so the
 * snapshot is the ONLY representation of a form field's value that reaches the
 * model. Password/credit-card fields are masked to a constant placeholder; the
 * real value never leaves the page.
 *
 * Deployments may extend the boundary without code changes: `dshSettings`
 * carries `extraSensitiveSelectors` (CSS selectors such as `[data-secret]` or
 * `.internal-note`) and `extraSensitiveKeywords` (name/id/aria-label
 * fragments). The content script applies them via
 * {@link configureSensitivePolicy} before any snapshot is taken.
 *
 * @module
 */

/** Name/id/aria-label fragments that mark a field as sensitive. */
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit/i,
  /card/i,
  /cvv/i,
  /cvc/i,
  /secret/i,
  /pwd/i,
]

/** Deployment-extended privacy rules; empty until configured. */
export interface SensitivePolicy {
  /** CSS selectors whose matched fields are always masked (e.g. `[data-secret]`). */
  selectors: string[]
  /** Extra name/id/aria-label fragments treated as sensitive. */
  keywords: string[]
}

const EMPTY_POLICY: SensitivePolicy = { selectors: [], keywords: [] }

let policy: SensitivePolicy = EMPTY_POLICY

/**
 * Apply deployment privacy rules. Call once from the content script before
 * any snapshot; replaces the previous policy wholesale.
 * @param next - the policy to apply; `undefined` resets to built-in rules only.
 */
export function configureSensitivePolicy(next: SensitivePolicy | undefined): void {
  policy = next === undefined
    ? { ...EMPTY_POLICY }
    : { selectors: [...next.selectors], keywords: [...next.keywords] }
}

/**
 * Whether a form field must never be echoed back to the model.
 * @param el - the form element (input/select/textarea).
 * @returns true for password inputs, credit-card autocomplete fields, and
 *   fields whose id/name/aria-label matches a sensitive fragment, plus any
 *   field matching the configured extra selectors or keywords.
 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return true
    const autocomplete = String(el.autocomplete)
    if (autocomplete === 'credit-card' || autocomplete.startsWith('cc-')) return true
  }
  if (policy.selectors.length > 0 && policy.selectors.some((selector) => el.matches(selector))) {
    return true
  }
  const name = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? el.name
    : ''
  const haystack = [el.id, name, el.getAttribute('aria-label')].filter(Boolean).join(' ')
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))
    || matchesConfiguredKeywords(haystack)
}

/**
 * Keyword matching collapses separators so `employee-id` still matches
 * `Employee ID`, `employee_id`, or `employee id` in the field identity.
 */
function matchesConfiguredKeywords(haystack: string): boolean {
  if (policy.keywords.length === 0) return false
  const normalized = haystack.toLowerCase().replace(/[\s_-]+/g, '')
  return policy.keywords.some((keyword) => normalized.includes(keyword.toLowerCase().replace(/[\s_-]+/g, '')))
}

/**
 * Mask a sensitive value for snapshots. Non-empty values become a fixed
 * placeholder so the model knows a value is present without learning it.
 * @param value - the field's current value.
 * @returns the masked representation.
 */
export function maskValue(value: string): string {
  return value.length === 0 ? '' : '••••'
}