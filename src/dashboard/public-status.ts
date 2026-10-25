import type { DashboardSnapshot } from "./types.js";

/**
 * A deliberately coarse label for spectators. Only the kind of work crosses
 * to the public page: never the task objective, target, resource or place.
 */
export type PublicActivity = "offline" | "recovering" | "building" | "gathering" | "exploring" | "resting" | "working";
export interface PublicStatus {
  activity: PublicActivity;
  /** One fixed sentence per activity; never built from snapshot text. */
  detail: string;
  /** When the current task started, if the label comes from one. */
  since: string | null;
}

const DETAIL: Record<PublicActivity, string> = {
  offline: "CobbleBob isn't connected to the world right now.",
  recovering: "Getting back on his feet: healing, eating or staying safe.",
  building: "Placing blocks on a construction project.",
  gathering: "Collecting materials and supplies.",
  exploring: "Travelling across the world.",
  resting: "Taking a break between jobs.",
  working: "Busy with chores around base.",
};

const BY_TASK: Record<string, PublicActivity> = {
  death_recovery: "recovering", recover_death_items: "recovering", defend_self: "recovering",
  build_base: "building", build_design: "building", build_structure: "building", build_project_acquire: "building",
  build_project_slice: "building", build_project_verify: "building", light_home: "building", create_storage: "building",
  develop_land: "building", clear_area: "building", world_project_acquire: "building", world_project_slice: "building",
  world_project_verify: "building", world_project_return: "building", world_project_deposit: "building", world_project_replace_tool: "building",
  collect_resource: "gathering", stockpile_maintenance: "gathering", gather_food: "gathering", hunt: "gathering", ensure_item: "gathering", farm: "gathering",
  travel_to: "exploring", explore: "exploring", expedition: "exploring", go_home: "exploring",
  sleep: "resting", night_shelter: "resting", wait: "resting",
};
/** Retreat health and the hunger level below which he stops to eat. */
const LOW_HEALTH = 8, LOW_HUNGER = 6;

export function publicStatus(snapshot: DashboardSnapshot): PublicStatus {
  const make = (activity: PublicActivity, since: string | null = null): PublicStatus => ({ activity, detail: DETAIL[activity], since });
  if (snapshot.connection.connected !== true) return make("offline");
  const task = snapshot.task !== null && ["active", "blocked"].includes(snapshot.task.status) ? snapshot.task : null;
  const byTask = task ? BY_TASK[task.type] : undefined;
  const { health, hunger } = snapshot.self;
  if (byTask === "recovering" || (typeof health === "number" && health <= LOW_HEALTH) || (typeof hunger === "number" && hunger <= LOW_HUNGER)) {
    return make("recovering", byTask === "recovering" ? task!.startedAt : null);
  }
  if (byTask) return make(byTask, task!.startedAt);
  if (task) return make("working", task.startedAt);
  // Between slices of a build there is no active task, but he is still building.
  const underway = (status: string | undefined): boolean => status === "active" || status === "verifying";
  if (underway(snapshot.buildProject?.status) || underway(snapshot.worldProject?.status)) return make("building");
  return make("resting");
}
