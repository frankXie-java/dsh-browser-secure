// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { configureSensitivePolicy, isSensitiveField, maskValue } from '../src/content/privacy.ts'

afterEach(() => {
  configureSensitivePolicy(undefined)
})

describe('isSensitiveField', () => {
  it('flags password inputs', () => {
    const input = document.createElement('input')
    input.type = 'password'
    expect(isSensitiveField(input)).toBe(true)
  })

  it('flags credit-card autocomplete fields', () => {
    const input = document.createElement('input')
    input.autocomplete = 'cc-number'
    expect(isSensitiveField(input)).toBe(true)
    const credit = document.createElement('input')
    ;(credit as { autocomplete: string }).autocomplete = 'credit-card'
    expect(isSensitiveField(credit)).toBe(true)
  })

  it('flags fields named like secrets', () => {
    for (const id of ['password', 'cardNumber', 'cvv2', 'credit_card', 'token_secret']) {
      const input = document.createElement('input')
      input.id = id
      expect(isSensitiveField(input)).toBe(true)
    }
  })

  it('leaves ordinary fields alone', () => {
    const input = document.createElement('input')
    input.id = 'email'
    expect(isSensitiveField(input)).toBe(false)
    expect(isSensitiveField(document.createElement('textarea'))).toBe(false)
  })

  it('flags fields matching configured extra selectors', () => {
    configureSensitivePolicy({ selectors: ['[data-secret]', '.internal-note'], keywords: [] })
    const flagged = document.createElement('input')
    flagged.dataset.secret = ''
    expect(isSensitiveField(flagged)).toBe(true)
    const classed = document.createElement('textarea')
    classed.className = 'internal-note'
    expect(isSensitiveField(classed)).toBe(true)
    const ordinary = document.createElement('input')
    ordinary.id = 'title'
    expect(isSensitiveField(ordinary)).toBe(false)
  })

  it('flags fields whose id/name/aria-label match configured keywords', () => {
    configureSensitivePolicy({ selectors: [], keywords: ['customer-no', 'employee-id'] })
    const byName = document.createElement('input')
    byName.name = 'customer-no'
    expect(isSensitiveField(byName)).toBe(true)
    const byAria = document.createElement('input')
    byAria.setAttribute('aria-label', 'Employee ID number')
    expect(isSensitiveField(byAria)).toBe(true)
    const ordinary = document.createElement('input')
    ordinary.name = 'display-name'
    expect(isSensitiveField(ordinary)).toBe(false)
  })

  it('resets to built-in rules after configureSensitivePolicy(undefined)', () => {
    configureSensitivePolicy({ selectors: ['[data-secret]'], keywords: ['customer-no'] })
    configureSensitivePolicy(undefined)
    const input = document.createElement('input')
    input.dataset.secret = ''
    expect(isSensitiveField(input)).toBe(false)
  })
})

describe('maskValue', () => {
  it('masks non-empty values and keeps empty values empty', () => {
    expect(maskValue('hunter2')).toBe('••••')
    expect(maskValue('')).toBe('')
  })
})
