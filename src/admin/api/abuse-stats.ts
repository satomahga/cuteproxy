import { Router } from "express";
import * as userStore from "../../shared/users/user-store";

const router = Router();

router.get("/", (_req, res) => {
  const users = userStore.getUsers();
  const now = Date.now();

  const isSuspended = (u: any) => {
    const m = (u?.meta || {}) as any;
    return typeof m.suspendUntil === "number" && m.suspendUntil > now;
  };

  const active = users.filter((u) => !u.disabledAt && !isSuspended(u)).length;
  const blocked = users.filter((u) => !!u.disabledAt).length;
  const suspended = users.filter((u) => isSuspended(u)).length;

  const blockedReasons: Record<string, number> = {};
  const suspendedReasons: Record<string, number> = {};
  for (const u of users) {
    if (u.disabledAt) {
      const reason = u.disabledReason || "Unknown";
      blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
    }
    if (isSuspended(u)) {
      const m = (u.meta || {}) as any;
      const reason = m.suspendReason || "Suspended";
      suspendedReasons[reason] = (suspendedReasons[reason] || 0) + 1;
    }
  }

  res.json({
    activeTokens: active,
    blockedTokens: blocked,
    blockedByReason: blockedReasons,
    suspendedTokens: suspended,
    suspendedByReason: suspendedReasons,
  });
});

export { router as abuseStatsApiRouter };
