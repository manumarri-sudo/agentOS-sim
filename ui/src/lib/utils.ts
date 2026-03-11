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
    return new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z')).toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch { return '' }
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'))
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'))
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 0) return 'just now'
    const secs = Math.floor(diff / 1000)
    if (secs < 60) return `${secs}s ago`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  } catch { return '' }
}

export function fmtDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso || !endIso) return ''
  try {
    const s = new Date(startIso + (startIso.includes('Z') || startIso.includes('+') ? '' : 'Z'))
    const e = new Date(endIso + (endIso.includes('Z') || endIso.includes('+') ? '' : 'Z'))
    const diff = e.getTime() - s.getTime()
    if (diff < 0) return ''
    const secs = Math.floor(diff / 1000)
    if (secs < 60) return `${secs}s`
    const mins = Math.floor(secs / 60)
    const remSecs = secs % 60
    if (mins < 60) return `${mins}m ${remSecs}s`
    const hrs = Math.floor(mins / 60)
    const remMins = mins % 60
    return `${hrs}h ${remMins}m`
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
