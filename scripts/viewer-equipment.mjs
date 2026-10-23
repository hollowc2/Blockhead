/** Browser code embedded in the viewer bundle by the install patch. */
export function createViewerEquipment(THREE, itemTextures = {}) {
  const textureRoot = "textures/1.21.4/";
  const textures = new Map();
  const slots = new Map();
  let model = null;
  let equipment = {};

  function material(path, color = 0xffffff) {
    if (!textures.has(path)) {
      const texture = new THREE.TextureLoader().load(textureRoot + path);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      textures.set(path, texture);
    }
    return new THREE.MeshLambertMaterial({ map: textures.get(path), color, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
  }

  // The player's model uses Minecraft pixels (16 per block), faces -Z,
  // and has its feet at Y=0. Armor uses the standard 64x32 cube UV layout.
  function armorCube(group, mat, origin, size, uv, inflate) {
    const [x, y, z] = origin;
    const [w, h, d] = size;
    const [u, v] = uv;
    const geometry = new THREE.BoxGeometry((w + 2 * inflate) / 16, (h + 2 * inflate) / 16, (d + 2 * inflate) / 16);
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z.
    const rects = [[u, v + d, d, h], [u + d + w, v + d, d, h],
      [u + d, v, w, d], [u + d + w, v, w, d],
      [u + 2 * d + w, v + d, w, h], [u + d, v + d, w, h]];
    const coords = geometry.attributes.uv;
    rects.forEach(([a, b, width, height], face) => {
      // The -Z face's U axis runs in the opposite direction to +Z.
      const flip = face === 5;
      for (let corner = 0; corner < 4; corner++) {
        const right = (corner % 2 === 1) !== flip;
        coords.setXY(face * 4 + corner, (a + (right ? width : 0)) / 64,
          1 - (b + (corner < 2 ? 0 : height)) / 32);
      }
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set((x + w / 2) / 16, (y + h / 2) / 16, (z + d / 2) / 16);
    group.add(mesh);
  }

  function armor(slot, name, group) {
    const match = /^(leather|chainmail|iron|golden|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/.exec(name);
    if (!match) return;
    const type = { golden: "gold", turtle: "turtle_scute" }[match[1]] ?? match[1];
    const layer = slot === "legs" ? "humanoid_leggings" : "humanoid";
    const path = `entity/equipment/${layer}/${type}.png`;
    // Leather's base layer needs its default brown tint.
    const mat = material(path, type === "leather" ? 0xa06540 : 0xffffff);
    const cube = (origin, size, uv, inflate = 1) => armorCube(group, mat, origin, size, uv, inflate);
    if (slot === "head") cube([-4, 24, -4], [8, 8, 8], [0, 0]);
    if (slot === "torso") {
      cube([-4, 12, -2], [8, 12, 4], [16, 16]);
      cube([-8, 12, -2], [4, 12, 4], [40, 16]);
      cube([4, 12, -2], [4, 12, 4], [40, 16]);
    }
    if (slot === "legs") {
      cube([-4, 12, -2], [8, 12, 4], [16, 16], 0.55);
      cube([-3.9, 0, -2], [4, 12, 4], [0, 16], 0.55);
      cube([-0.1, 0, -2], [4, 12, 4], [0, 16], 0.55);
    }
    if (slot === "feet") {
      cube([-3.9, 0, -2], [4, 12, 4], [0, 16]);
      cube([-0.1, 0, -2], [4, 12, 4], [0, 16]);
    }
  }

  function held(slot, name, group) {
    const side = slot === "hand" ? -1 : 1;
    if (name === "shield") {
      // Shields have a 3D board rather than a flat inventory sprite.
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.65, 0.42), new THREE.MeshLambertMaterial({ color: 0x6b4b2a }));
      board.position.set(side * 0.47, 0.9, -0.18);
      group.add(board);
      for (const y of [0.59, 1.21]) {
        const rim = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.04, 0.44), new THREE.MeshLambertMaterial({ color: 0xa6a6a6 }));
        rim.position.set(side * 0.47, y, -0.18);
        group.add(rim);
      }
      return;
    }
    const texture = itemTextures[name] ?? `items/${name}.png`;
    const mat = material(texture);
    const block = texture.startsWith("blocks/");
    const geometry = block ? new THREE.BoxGeometry(0.25, 0.25, 0.25) : new THREE.PlaneGeometry(0.7, 0.7);
    // Put the handle, rather than the image center, in the hand.
    const tool = /_(sword|pickaxe|axe|shovel|hoe)$/.test(name);
    if (tool) geometry.translate(0.22, 0.22, 0);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.rotation.set(tool ? -0.6 : 0, Math.PI / 2, tool ? -Math.PI / 4 : 0);
    mesh.position.set(side * 0.375, 0.83, -0.19);
    group.add(mesh);
  }

  function clear(group) {
    group.traverse(part => {
      part.geometry?.dispose();
      if (part.material) part.material.dispose();
    });
    group.parent?.remove(group);
  }

  function render() {
    if (!model) return;
    for (const slot of ["hand", "off-hand", "head", "torso", "legs", "feet"]) {
      const raw = equipment[slot];
      const name = typeof raw === "string" && /^[a-z0-9_]+$/.test(raw) ? raw : null;
      const previous = slots.get(slot);
      if (previous?.name === name) continue;
      if (previous) clear(previous.group);
      const group = new THREE.Group();
      group.name = `equipment:${slot}`;
      if (name) {
        if (slot === "hand" || slot === "off-hand") held(slot, name, group);
        else armor(slot, name, group);
      }
      model.add(group);
      slots.set(slot, { name, group });
    }
  }

  return {
    update(value) { equipment = value ?? {}; render(); },
    attach(value) {
      if (model === value) return;
      for (const { group } of slots.values()) clear(group);
      slots.clear();
      model = value;
      render();
    },
  };
}
