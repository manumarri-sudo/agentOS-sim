// ---------------------------------------------------------------------------
// Reward System — central exports
// The most sensitive code in the orchestrator (CLAUDE.md rule #3)
// ---------------------------------------------------------------------------

export {
  recalculateCFS,
  recalculateAllCFS,
  updateAllTiers,
  logCollaborationEvent,
  getCFSSummary,
  getAgentCollaborationHistory,
  CFS_WEIGHTS,
  TIER_THRESHOLDS,
} from './ledger'

export {
  computeAttribution,
  runAttribution,
  recordRevenueEvent,
  getAttributionSummary,
} from './attribution'

export {
  checkQuorumStatus,
  attemptPhaseAdvance,
  recordQuorumContribution,
  initializeQuorum,
  getRequiredTeams,
} from './quorum'

export {
  requiresCrossApproval,
  requestCrossApproval,
  approveCrossApproval,
  rejectCrossApproval,
  getPendingCrossApprovals,
} from './cross-approval'

export {
  reportBlocked,
  resolveBlocker,
  getActiveBlockers,
  getBlockerHistory,
} from './blockers'

export {
  recordVelocityAssessment,
  submitDeadlineRevision,
  setPhaseDeadline,
  finalizePhaseVelocity,
  getVelocityMetrics,
} from './velocity'

export {
  verify as verifyAction,
  isSubstantive,
  hashOutput,
} from './verifier'

export {
  shouldSpotCheck,
  runSpotChecks,
} from './spot-check'
