/**
 * rbac.js — role-based access control middleware.
 *
 * Role hierarchy (higher number = more privilege):
 *   external_caller (0) — Blake et al. Call list, cockpit, own history, practice.
 *   caller          (1) — Internal @joruva.com team. Full call surface + ask + scoreboard.
 *   admin           (2) — Tom, Paul. Signals, curation, equipment config, user mgmt.
 *
 * Usage:
 *   router.get('/foo', sessionAuth, rbac('caller'), handler)
 *
 * rbac() MUST be composed AFTER a session/auth middleware that populates
 * req.user. It fails open to 401 if req.user is missing, which is defensive
 * in case a route is accidentally mounted without session auth.
 */

const ROLE_HIERARCHY = {
  external_caller: 0,
  caller: 1,
  admin: 2,
};

function rbac(minRole) {
  if (!(minRole in ROLE_HIERARCHY)) {
    throw new Error(`rbac: unknown minRole '${minRole}'`);
  }
  const required = ROLE_HIERARCHY[minRole];
  return function rbacMiddleware(req, res, next) {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const actual = ROLE_HIERARCHY[user.role] ?? -1;
    if (actual < required) {
      return res.status(403).json({
        error: `Requires ${minRole} role`,
      });
    }
    next();
  };
}

function hasMinRole(role, minRole) {
  return (ROLE_HIERARCHY[role] ?? -1) >= (ROLE_HIERARCHY[minRole] ?? 0);
}

module.exports = { rbac, hasMinRole, ROLE_HIERARCHY };
