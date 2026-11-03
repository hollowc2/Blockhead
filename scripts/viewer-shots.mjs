/**
 * Two more camera shots for the viewer's bobCam (patch-prismarine-viewer.mjs),
 * used by the broadcast's camera rotation (broadcast-scenes.mjs):
 *  - wide:  a slow orbit around CobbleBob from above and further out, always
 *           looking at him; a ray from his head pulls it in when terrain is
 *           in the way, so underground it closes in instead of filming rock
 *  - close: the follow shot on a short boom, a little lower, for fights,
 *           builds starting and ore
 * The function is inlined into the browser bundle with toString(), so it
 * may only use its arguments: the bobCam object, THREE and the viewer
 * (for playerHeight and the section meshes the ray tests against). It
 * wraps bobCam's goal/probe/set/frame and leaves orbit, follow and eyes
 * exactly as they were.
 */
export function installViewerShots(cam, THREE, viewer) {
  const CLOSE_BOOM = 2.8, CLOSE_PITCH = -0.2;
  const WIDE_RADIUS = 14, WIDE_HEIGHT = 9, WIDE_LAP_S = 150;
  const base = { goal: cam.goal, probe: cam.probe, set: cam.set, frame: cam.frame };
  const ours = (mode) => mode === "wide" || mode === "close";
  const turn = (a, b, k) => a + ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * k;
  cam.lap = 0;
  // How much of the wide shot's distance is clear of terrain (0.08-1), eased.
  cam.reach = 1;
  cam.wantReach = 1;
  cam.wideProbed = 0;

  cam.probe = function () {
    base.probe.call(this);
    if (this.mode === "close") this.want = Math.min(this.want, CLOSE_BOOM);
  };
  cam.wideOffset = function () {
    return { x: Math.sin(this.lap) * WIDE_RADIUS, y: WIDE_HEIGHT, z: Math.cos(this.lap) * WIDE_RADIUS };
  };
  cam.probeWide = function () {
    const t = this.pos, head = new THREE.Vector3(t.x, t.y + viewer.playerHeight, t.z), o = this.wideOffset();
    const way = new THREE.Vector3(o.x, o.y, o.z), far = way.length();
    const near = Object.values(viewer.world.sectionMeshs).filter((mesh) => mesh.position.distanceTo(head) < far + 24);
    this.ray.set(head, way.normalize());
    this.ray.far = far;
    const hit = this.ray.intersectObjects(near, false)[0];
    this.wantReach = hit ? Math.max(0.08, (hit.distance - 0.5) / far) : 1;
  };
  cam.goal = function () {
    if (!ours(this.mode)) return base.goal.call(this);
    const t = this.pos, eye = t.y + viewer.playerHeight;
    if (this.mode === "close") {
      const d = this.dir(this.cam.yaw), b = this.boom;
      return { x: t.x + d.x * b, y: eye + d.y * b, z: t.z + d.z * b, yaw: this.heading, pitch: CLOSE_PITCH };
    }
    const o = this.wideOffset(), r = this.reach;
    return { x: t.x + o.x * r, y: eye + o.y * r, z: t.z + o.z * r, yaw: this.lap, pitch: -Math.atan2(o.y, Math.hypot(o.x, o.z)) };
  };
  /** Turn the camera to look at CobbleBob from wherever it is. */
  cam.aim = function () {
    const t = this.pos, dx = t.x - this.cam.x, dz = t.z - this.cam.z, dy = t.y + viewer.playerHeight * 0.6 - this.cam.y;
    if (dx * dx + dz * dz < 1e-6) return;
    this.cam.yaw = Math.atan2(-dx, -dz);
    this.cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  };
  cam.set = function (mode) {
    if (mode === this.mode) return;
    // The wide shot opens from behind him, where the follow camera was.
    if (mode === "wide") this.lap = this.heading;
    base.set.call(this, mode);
    if (!ours(mode) || !this.pos) return;
    if (mode === "close") { this.probe(); this.boom = this.want; }
    else { this.probeWide(); this.reach = this.wantReach; }
    Object.assign(this.cam, this.goal());
    if (mode === "wide") this.aim();
    this.place();
  };
  cam.frame = function (now) {
    if (!ours(this.mode) || !this.pos) return base.frame.call(this, now);
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1e3) : 0;
    this.last = now;
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    if (this.mode === "close") {
      this.cam.yaw = turn(this.cam.yaw, this.heading, ease(2.5));
      if (now - this.probed > 150) { this.probed = now; this.probe(); }
      this.boom += (this.want - this.boom) * ease(this.want < this.boom ? 20 : 2);
      const g = this.goal(), move = ease(6);
      this.cam.pitch += (g.pitch - this.cam.pitch) * ease(2.5);
      this.cam.x += (g.x - this.cam.x) * move; this.cam.y += (g.y - this.cam.y) * move; this.cam.z += (g.z - this.cam.z) * move;
    } else {
      this.lap += dt * 2 * Math.PI / WIDE_LAP_S;
      if (now - this.wideProbed > 250) { this.wideProbed = now; this.probeWide(); }
      this.reach += (this.wantReach - this.reach) * ease(this.wantReach < this.reach ? 12 : 1.5);
      const g = this.goal(), move = ease(3);
      this.cam.x += (g.x - this.cam.x) * move; this.cam.y += (g.y - this.cam.y) * move; this.cam.z += (g.z - this.cam.z) * move;
      this.aim();
    }
    this.place();
  };
}
