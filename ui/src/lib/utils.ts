// Team colors
export const TEAM_COLORS: Record<string, string> = {
  exec: '#61afef',
  strategy: '#c678dd',
  tech: '#98c379',
  ops: '#d19a66',
  marketing: '#e5c07b',
}

// Tier labels
export const TIER_NAMES: Record<number, string> = {
  0: 'Provisional',
  1: 'Contributor',
  2: 'Trusted',
  3: 'Core',
}

export const TIER_COLORS: Record<number, string> = {
  0: '#5c6370',
  1: '#61afef',
  2: '#98c379',
  3: '#e5c07b',
}

export const STATUS_COLORS: Record<string, string> = {
  idle: '#5c6370',
  working: '#61afef',
  suspended: '#e06c75',
  rate_limited: '#e5c07b',
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch { return '' }
}

export function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`
}

export function costColor(pct: number): string {
  if (pct > 80) return '#e06c75'
  if (pct > 50) return '#e5c07b'
  return '#98c379'
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function trendArrow(trend: string): string {
  switch (trend) {
    case 'ahead': return '\u25B2'
    case 'behind': return '\u25BC'
    case 'on_pace': return '\u25C6'
    default: return '\u2014'
  }
}

export function trendColor(trend: string): string {
  switch (trend) {
    case 'ahead': return '#98c379'
    case 'behind': return '#e06c75'
    case 'on_pace': return '#61afef'
    default: return '#5c6370'
  }
}

export function priorityColor(p: string): string {
  switch (p) {
    case 'urgent': return '#e06c75'
    case 'high': return '#e5c07b'
    case 'normal': return '#c5c8c6'
    case 'low': return '#5c6370'
    default: return '#5c6370'
  }
}
