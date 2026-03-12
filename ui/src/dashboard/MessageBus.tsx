import { fmtTime, priorityColor, TEAM_COLORS } from '../lib/utils'

interface MessageBusProps {
  messages: any[]
}

export function MessageBus({ messages }: MessageBusProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-border text-[10px] text-muted tracking-[0.1em] flex justify-between">
        <span>MESSAGE BUS</span>
        <span>{messages.length}</span>
      </div>

      <div className="flex-1 overflow-auto">
        {messages.length === 0 && (
          <div className="p-4 text-muted text-[11px]">No messages yet.</div>
        )}

        {messages.map((msg: any) => (
          <div
            key={msg.id}
            className="px-3 py-1.5 border-b border-bg hover:bg-border/20"
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-muted text-[9px] shrink-0 w-14">
                {fmtTime(msg.created_at)}
              </span>

              {/* Priority indicator */}
              <span
                className="text-[8px] shrink-0"
                style={{ color: priorityColor(msg.priority) }}
              >
                {'\u25CF'}
              </span>

              {/* From */}
              <span className="text-accent shrink-0">
                {msg.from_name ?? msg.from_agent_id}
              </span>

              <span className="text-muted">{'\u2192'}</span>

              {/* To */}
              <span className="text-text shrink-0">
                {msg.to_name ?? msg.to_team ?? msg.to_agent_id ?? 'broadcast'}
              </span>

              {/* Status */}
              <span className={`text-[9px] px-1 border ml-auto shrink-0
                ${msg.status === 'actioned' ? 'text-success border-success' :
                  msg.status === 'read' ? 'text-accent border-accent' :
                  msg.status === 'ignored' ? 'text-muted border-border' :
                  'text-warn border-warn'}`}
              >
                {msg.status}
              </span>
            </div>

            {/* Subject */}
            <div className="ml-[72px] text-[10px] text-text break-words mt-0.5">
              {msg.subject}
            </div>

            {/* Body preview */}
            {msg.body && (
              <div className="ml-[72px] text-[9px] text-muted break-words whitespace-pre-wrap mt-0.5">
                {msg.body}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
