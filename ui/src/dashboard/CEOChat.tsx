import { useState, useEffect, useRef } from 'react'
import { useAPI } from '../hooks/useAPI'
import { apiFetch } from '../lib/api'

export function CEOChat() {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const userScrolledRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const { data: messages, refetch } = useAPI<any[]>('/api/ceo-chat?limit=200', 5000, [])
  const { data: unread } = useAPI<{ unread: number }>('/api/ceo-chat/unread', 5000)

  // Only auto-scroll when a NEW message arrives, not on every poll
  useEffect(() => {
    const count = (messages ?? []).length
    if (count > prevCountRef.current && !userScrolledRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevCountRef.current = count
  }, [messages])

  // Detect if user has scrolled up — stop auto-scrolling
  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    userScrolledRef.current = !atBottom
  }

  async function send() {
    if (!input.trim() || sending) return
    setSending(true)
    userScrolledRef.current = false // re-enable auto-scroll when user sends
    try {
      await apiFetch('/api/ceo-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input.trim() }),
      })
      setInput('')
      refetch()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border flex items-center gap-2">
        <div className="text-[10px] text-muted tracking-[0.1em]">CEO CHANNEL</div>
        <div className="text-[10px] text-accent">Reza</div>
        {(unread?.unread ?? 0) > 0 && (
          <span className="ml-auto bg-accent text-bg text-[9px] px-1.5 py-0.5 rounded-full">
            {unread!.unread} new
          </span>
        )}
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-3 space-y-2"
      >
        {(messages ?? []).length === 0 ? (
          <div className="text-muted text-[10px] text-center mt-8">
            No messages yet. Send a message to Reza.
          </div>
        ) : (
          (messages ?? []).map((m: any) => (
            <div
              key={m.id}
              className={`max-w-[85%] ${m.sender === 'human' ? 'ml-auto' : 'mr-auto'}`}
            >
              <div
                className={`px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap ${
                  m.sender === 'human'
                    ? 'bg-accent/15 border border-accent/30 text-text'
                    : m.message_type === 'alert' || m.message_type === 'phase_request'
                    ? 'bg-warning/10 border border-warning/30 text-text'
                    : 'bg-panel border border-border text-text'
                }`}
              >
                {m.message_type && m.message_type !== 'chat' && (
                  <div className="text-[9px] text-muted uppercase tracking-wider mb-1">
                    {m.message_type === 'phase_request' ? 'PHASE ADVANCE REQUEST' :
                     m.message_type === 'alert' ? 'ALERT' :
                     m.message_type === 'decision' ? 'DECISION' :
                     m.message_type === 'approval_needed' ? 'NEEDS APPROVAL' :
                     m.message_type}
                  </div>
                )}
                {m.message}
              </div>
              <div className="text-[8px] text-muted mt-0.5 px-1">
                {m.sender === 'human' ? 'You' : 'Reza'}
                {m.sim_day ? ` · Day ${m.sim_day}` : ''}
                {m.created_at ? ` · ${new Date(m.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-2 border-t border-border flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Message Reza..."
          className="flex-1 bg-bg border border-border px-2 py-1.5 text-[11px] text-text focus:border-accent outline-none"
        />
        <button
          onClick={send}
          disabled={!input.trim() || sending}
          className="px-3 py-1.5 text-[10px] tracking-wider border border-accent text-accent hover:bg-accent/10 disabled:opacity-30 transition-colors"
        >
          SEND
        </button>
      </div>
    </div>
  )
}
