import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'

// Generic fetch hook with polling
export function useAPI<T>(url: string, interval = 5000, initial?: T) {
  const [data, setData] = useState<T | undefined>(initial)
  const [error, setError] = useState<string | null>(null)

  const fetch_ = useCallback(async () => {
    if (!url) return  // skip fetch for empty/disabled URLs
    try {
      const res = await apiFetch(url)
      if (!res.ok) throw new Error(`${res.status}`)
      const json = await res.json() as T
      setData(json)
      setError(null)
    } catch (e: any) {
      setError(e.message)
    }
  }, [url])

  useEffect(() => {
    if (!url) return  // don't poll empty URLs
    fetch_()
    const t = setInterval(fetch_, interval)
    return () => clearInterval(t)
  }, [fetch_, interval])

  return { data, error, refetch: fetch_ }
}

// SSE hook for real-time events
export function useSSE(url: string) {
  const [connected, setConnected] = useState(false)
  const [events, setEvents] = useState<any[]>([])
  const eventsRef = useRef<any[]>([])

  useEffect(() => {
    let es: EventSource
    let delay = 1000

    function connect() {
      es = new EventSource(url)
      es.addEventListener('connected', (() => {
        setConnected(true)
        delay = 1000
      }) as EventListener)
      es.addEventListener('heartbeat', () => {})
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          eventsRef.current = [data, ...eventsRef.current].slice(0, 200)
          setEvents([...eventsRef.current])
        } catch {}
      }
      es.onerror = () => {
        setConnected(false)
        es.close()
        setTimeout(connect, delay)
        delay = Math.min(delay * 2, 30000)
      }
    }

    connect()
    return () => { es?.close() }
  }, [url])

  return { connected, events }
}
