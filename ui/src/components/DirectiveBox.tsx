import { useState } from 'react'
import { useAPI } from '../hooks/useAPI'
import { apiFetch } from '../lib/api'

export function DirectiveBox() {
  const { data: agents } = useAPI<any[]>('/api/agents', 10000, [])
  const [target, setTarget] = useState('')
  const [message, setMessage] = useState('')
  const [createTask, setCreateTask] = useState(true)
  const [sent, setSent] = useState(false)

  const send = async () => {
    if (!target || !message) return
    await apiFetch('/api/directive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgentId: target, message, createTask }),
    })
    setSent(true)
    setMessage('')
    setTimeout(() => setSent(false), 3000)
  }

  return (
    <div className="border-b border-border p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-2">SEND DIRECTIVE</div>

      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-full bg-bg border border-border px-2 py-1 text-text text-[11px] mb-2 outline-none focus:border-accent"
      >
        <option value="">Select agent...</option>
        {(agents ?? []).map((a: any) => (
          <option key={a.id} value={a.id}>
            {a.personality_name} — {a.role} ({a.team})
          </option>
        ))}
      </select>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Write your directive..."
        className="w-full bg-bg border border-border px-2 py-1.5 text-text text-[11px] mb-2 outline-none focus:border-accent resize-none"
        rows={3}
      />

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={createTask}
            onChange={(e) => setCreateTask(e.target.checked)}
            className="accent-accent"
          />
          Also create a task
        </label>

        <button
          onClick={send}
          disabled={!target || !message}
          className="ml-auto text-[10px] px-3 py-1 border border-accent text-accent hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {sent ? 'SENT' : 'SEND'}
        </button>
      </div>
    </div>
  )
}
