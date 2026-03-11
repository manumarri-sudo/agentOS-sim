// Authenticated fetch wrapper for dashboard API calls
const TOKEN_KEY = 'agentos-token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

function ensureToken(): string {
  let token = getToken()
  if (!token) {
    token = window.prompt('Enter your AgentOS dashboard token:') ?? ''
    if (token) setToken(token)
  }
  return token
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET'

  // For write operations, ensure we have a token
  if (method !== 'GET') {
    ensureToken()
  }

  return fetch(url, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  })
}
