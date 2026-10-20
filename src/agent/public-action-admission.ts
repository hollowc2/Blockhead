/** Private diagnostics and admission share these exact, synchronous checks. */
export type AdmissionGate = "session" | "physical" | "freshness" | "threats" | "death_loop"
  | "scheduler" | "projects" | "lease_waiters" | "lease_owner" | "active_task" | "queued_tasks"
  | "interrupt" | "background" | "decision" | "goal" | "bootstrap";
export type AdmissionCheck = readonly [AdmissionGate, () => boolean];
export interface AdmissionAssessment<Name extends string = AdmissionGate> {
  safe: boolean;
  checks: Partial<Record<Name, "pass" | "blocked" | "unknown">>;
}

/** No promises, exceptions, task details or side effects cross this boundary. */
export function assessPublicAdmission<Name extends string = AdmissionGate>(checks: readonly (readonly [Name, () => boolean])[], collectAll = false): AdmissionAssessment<Name> {
  const result: AdmissionAssessment<Name> = { safe: checks.length > 0, checks: {} };
  for (const [name, read] of checks) {
    let state: "pass" | "blocked" | "unknown";
    try {
      const value = read();
      state = value === true ? "pass" : value === false ? "blocked" : "unknown";
    } catch { state = "unknown"; }
    result.checks[name] = state;
    if (state !== "pass") {
      result.safe = false;
      if (!collectAll) break;
    }
  }
  return result;
}
