import { useState, useEffect } from 'react'
import { useAPI } from '../hooks/useAPI'
import { fmtTime } from '../lib/utils'
import { apiFetch } from '../lib/api'

export function MarketingQueue() {
  const { data: queue, refetch } = useAPI<any[]>('/api/marketing/queue', 8000, [])

  const handleApprove = async (id: string) => {
    await apiFetch(`/api/marketing/queue/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'human' }),
    })
    refetch()
  }

  const handleReject = async (id: string) => {
    const reason = prompt('Rejection reason?')
    if (!reason) return
    await apiFetch(`/api/marketing/queue/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    refetch()
  }

  // Group by status
  const pending = (queue ?? []).filter((q: any) => q.status === 'pending')
  const approved = (queue ?? []).filter((q: any) => q.status === 'approved')
  const posted = (queue ?? []).filter((q: any) => q.status === 'posted')
  const rejected = (queue ?? []).filter((q: any) => q.status === 'rejected')

  return (
    <div className="p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">
        MARKETING QUEUE
        <span className="text-warn ml-2">
          {pending.length} pending
        </span>
      </div>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <>
          <div className="text-[9px] text-warn tracking-[0.05em] mb-2">NEEDS APPROVAL</div>
          {pending.map((item: any) => (
            <div key={item.id} className="border border-warn/30 p-3 mb-2">
              {/* Header */}
              <div className="flex items-center gap-2 mb-2 text-[11px]">
                <span className="text-warn px-1 border border-warn text-[9px]">
                  {item.platform}
                </span>
                {item.subreddit && (
                  <span className="text-muted text-[10px]">r/{item.subreddit}</span>
                )}
                <span className="text-muted text-[9px] ml-auto">
                  by {item.agent_name ?? item.agent_id}
                </span>
              </div>

              {/* Title */}
              {item.title && (
                <div className="text-text text-[11px] mb-1 font-medium">{item.title}</div>
              )}

              {/* Body preview */}
              <div className="text-muted text-[10px] mb-2 whitespace-pre-wrap break-words max-h-24 overflow-hidden">
                {item.body?.slice(0, 300)}
                {item.body?.length > 300 && '...'}
              </div>

              {/* Agent rationale — doc 6 Issue 14 */}
              {item.agent_rationale && (
                <div className="border-l-2 border-accent pl-2 mb-2">
                  <div className="text-[8px] text-accent tracking-[0.05em] mb-0.5">RATIONALE</div>
                  <div className="text-[9px] text-muted">{item.agent_rationale}</div>
                </div>
              )}

              {/* Source URL */}
              {item.source_url && (
                <div className="text-[9px] text-muted mb-1">
                  Source: <span className="text-accent">{item.source_url}</span>
                </div>
              )}

              {/* Metrics row */}
              <div className="flex gap-3 text-[9px] text-muted mb-2">
                {item.expected_reach && (
                  <span>Reach: <span className="text-text">{item.expected_reach}</span></span>
                )}
                {item.confidence && (
                  <span>Confidence: <span className="text-text">{item.confidence}/10</span></span>
                )}
                {item.subreddit_karma_check && (
                  <span className="text-warn">{item.subreddit_karma_check}</span>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleApprove(item.id)}
                  className="text-[10px] px-3 py-1 border border-success text-success hover:bg-success/10 transition-colors"
                >
                  APPROVE
                </button>
                <button
                  onClick={() => handleReject(item.id)}
                  className="text-[10px] px-3 py-1 border border-danger text-danger hover:bg-danger/10 transition-colors"
                >
                  REJECT
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Approved / Posted */}
      {approved.length > 0 && (
        <>
          <div className="text-[9px] text-success tracking-[0.05em] mb-1 mt-3">APPROVED ({approved.length})</div>
          {approved.map((item: any) => (
            <div key={item.id} className="flex items-center gap-2 text-[10px] py-1 border-b border-bg">
              <span className="text-success">{'\u2713'}</span>
              <span className="text-muted">{item.platform}</span>
              <span className="text-text truncate flex-1">{item.title || item.body?.slice(0, 60)}</span>
            </div>
          ))}
        </>
      )}

      {posted.length > 0 && (
        <>
          <div className="text-[9px] text-accent tracking-[0.05em] mb-1 mt-3">POSTED ({posted.length})</div>
          {posted.map((item: any) => (
            <div key={item.id} className="flex items-center gap-2 text-[10px] py-1 border-b border-bg">
              <span className="text-accent">{'\u25B6'}</span>
              <span className="text-muted">{item.platform}</span>
              <span className="text-text truncate flex-1">{item.title || item.body?.slice(0, 60)}</span>
              {item.post_url && <span className="text-accent text-[9px]">link</span>}
            </div>
          ))}
        </>
      )}

      {rejected.length > 0 && (
        <>
          <div className="text-[9px] text-danger tracking-[0.05em] mb-1 mt-3">REJECTED ({rejected.length})</div>
          {rejected.map((item: any) => (
            <div key={item.id} className="flex items-center gap-2 text-[10px] py-1 border-b border-bg">
              <span className="text-danger">{'\u2717'}</span>
              <span className="text-muted">{item.platform}</span>
              <span className="text-text truncate flex-1">{item.title || item.body?.slice(0, 60)}</span>
            </div>
          ))}
        </>
      )}

      {(queue ?? []).length === 0 && (
        <div className="text-muted text-[11px] mt-2">
          No marketing posts queued. Posts appear when agents draft content in Phase 4+.
        </div>
      )}
    </div>
  )
}
