import type { SyncPlan } from './types';

export function deletionLimit(knownItemCount: number): number {
  return Math.max(5, knownItemCount * 0.1);
}

export function applyDeletionBrake(
  plan: SyncPlan,
  knownItemCount: number,
): SyncPlan {
  const deletionCount = plan.actions.filter(
    (action) =>
      action.type === 'deleteLocal' || action.type === 'deleteRemote',
  ).length;
  const limit = deletionLimit(knownItemCount);

  if (deletionCount <= limit) {
    return { ...plan, deletionCount };
  }

  const deletionReason =
    `Deletion guard: ${deletionCount} deletions exceed ` +
    `the limit of ${formatLimit(limit)} for ${knownItemCount} known items.`;

  return {
    ...plan,
    deletionCount,
    blocked: true,
    blockReason:
      plan.blockReason === undefined
        ? deletionReason
        : `${plan.blockReason} ${deletionReason}`,
  };
}

function formatLimit(limit: number): string {
  return Number.isInteger(limit) ? String(limit) : limit.toFixed(1);
}
