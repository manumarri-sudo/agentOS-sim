-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_actions_agent_id ON actions(agent_id);
CREATE INDEX IF NOT EXISTS idx_actions_phase ON actions(phase);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_agent_phase ON actions(agent_id, phase);

CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_team ON messages(to_team);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

CREATE INDEX IF NOT EXISTS idx_budget_entries_agent ON budget_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_budget_entries_category ON budget_entries(category);
CREATE INDEX IF NOT EXISTS idx_budget_entries_phase ON budget_entries(phase);

CREATE INDEX IF NOT EXISTS idx_collab_events_from ON collaboration_events(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_collab_events_to ON collaboration_events(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_collab_events_phase ON collaboration_events(phase);

CREATE INDEX IF NOT EXISTS idx_worktrees_agent ON worktrees(agent_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);

CREATE INDEX IF NOT EXISTS idx_marketing_queue_status ON marketing_queue(status);
CREATE INDEX IF NOT EXISTS idx_marketing_queue_agent ON marketing_queue(agent_id);

CREATE INDEX IF NOT EXISTS idx_revenue_attr_agent ON revenue_attribution(agent_id);
CREATE INDEX IF NOT EXISTS idx_revenue_attr_event ON revenue_attribution(revenue_event_id);

CREATE INDEX IF NOT EXISTS idx_velocity_agent_phase ON agent_velocity(agent_id, phase);

CREATE INDEX IF NOT EXISTS idx_blocked_agents_agent ON blocked_agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_blocked_agents_resolved ON blocked_agents(resolved_by);

CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(made_by_agent);
CREATE INDEX IF NOT EXISTS idx_decisions_phase ON decisions(phase);
