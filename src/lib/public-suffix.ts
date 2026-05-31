import { PSL_RULES } from './public-suffix-data.js'

function normalizeHost(input: string): string {
  return input.replace(/\.$/, '').toLowerCase()
}

function isIpLiteral(host: string): boolean {
  // IPv6 literals contain a colon; requiring one avoids misclassifying
  // all-hex single-label hosts (e.g. the ccTLDs `ca`, `ac`, `be`) as IPs.
  return /^(\d+\.){3}\d+$/.test(host) || (host.includes(':') && /^[0-9a-f:]+$/i.test(host))
}

type RuleSets = {
  exact: Set<string>
  wildcard: Set<string>
  exception: Set<string>
}

function buildRuleSets(): RuleSets {
  const exact = new Set<string>()
  const wildcard = new Set<string>()
  const exception = new Set<string>()

  for (const line of PSL_RULES.split('\n')) {
    if (!line) continue
    if (line.startsWith('!')) {
      exception.add(line.slice(1))
      continue
    }
    if (line.startsWith('*.')) {
      wildcard.add(line.slice(2))
      continue
    }
    exact.add(line)
  }

  return { exact, wildcard, exception }
}

const RULES = buildRuleSets()

function getPublicSuffix(host: string): string {
  const labels = host.split('.')
  let bestMatch = labels.at(-1) ?? host
  let bestMatchLength = bestMatch ? bestMatch.split('.').length : 0

  for (let index = 0; index < labels.length; index++) {
    const candidate = labels.slice(index).join('.')

    if (RULES.exception.has(candidate)) {
      return labels.slice(index + 1).join('.')
    }

    if (RULES.exact.has(candidate)) {
      const candidateLength = labels.length - index
      if (candidateLength > bestMatchLength) {
        bestMatch = candidate
        bestMatchLength = candidateLength
      }
    }

    if (index < labels.length - 1) {
      const wildcardBase = labels.slice(index + 1).join('.')
      if (RULES.wildcard.has(wildcardBase)) {
        const candidateLength = labels.length - index
        if (candidateLength > bestMatchLength) {
          bestMatch = candidate
          bestMatchLength = candidateLength
        }
      }
    }
  }

  return bestMatch
}

export function getEtld1(host: string): string {
  const normalized = normalizeHost(host)
  if (!normalized) return normalized
  if (normalized === 'localhost' || isIpLiteral(normalized) || !normalized.includes('.')) {
    return normalized
  }

  const labels = normalized.split('.')
  const publicSuffix = getPublicSuffix(normalized)
  const publicSuffixLabels = publicSuffix.split('.')

  if (labels.length <= publicSuffixLabels.length) {
    return normalized
  }

  return labels.slice(labels.length - publicSuffixLabels.length - 1).join('.')
}

export function isPublicSuffix(domain: string): boolean {
  const normalized = normalizeHost(domain)
  if (!normalized) return false
  if (normalized === 'localhost' || isIpLiteral(normalized)) return false
  return getPublicSuffix(normalized) === normalized
}
