// Team roster — single source of truth imported from server/config/team.json
// via the @server-config Vite alias. Fixes prior drift between History.jsx
// (6 reps) and CallSummary.jsx (7 reps, included Lily).
import team from '@server-config/team.json';

export const TEAM_MEMBERS = team.members;

export const CALLER_OPTIONS = team.members.map((m) => ({
  value: m.identity,
  label: m.name,
}));
