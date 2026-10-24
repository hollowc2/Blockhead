/**
 * Browser code embedded in the viewer bundle by the install patch: a
 * translucent ghost of a planned build, its footprint outline and an arrow
 * out of its entrance. The private viewer shell sends `bob-preview` events
 * (null clears); nothing here talks to the server.
 */
export function installViewerPreview(THREE, scene) {
  const KNOWN = {
    stone_bricks: 0x8f8f8f, cobblestone: 0x7a7a7a, smooth_stone: 0xa6a6a6, glass: 0x9fd8ef, torch: 0xffc94d,
    oak_door: 0xa0794a, bookshelf: 0x7b5a32, red_carpet: 0xb3312c, cyan_concrete: 0x15889a, oak_planks: 0xb8945f,
    spruce_planks: 0x7a5a36, birch_planks: 0xd7c88a, jungle_planks: 0xb1805c, acacia_planks: 0xb8623a,
    dark_oak_planks: 0x4b311a, mangrove_planks: 0x7a3a33, cherry_planks: 0xe2b4a9, pale_oak_planks: 0xe3dad3,
  };
  let group = null;
  const color = (name, index) => KNOWN[name] ?? new THREE.Color().setHSL(((index * 0.137) + 0.08) % 1, 0.55, 0.55).getHex();
  function clear() {
    if (group === null) return;
    scene.remove(group);
    group.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
    group = null;
  }
  function show(preview) {
    clear();
    if (!preview || !Array.isArray(preview.blocks) || !Array.isArray(preview.palette)) return;
    group = new THREE.Group();
    group.name = "bob-preview";
    const cube = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    const counts = preview.palette.map(() => 0);
    for (let i = 3; i < preview.blocks.length; i += 4) counts[preview.blocks[i]] = (counts[preview.blocks[i]] ?? 0) + 1;
    const meshes = preview.palette.map((name, index) => {
      if (!counts[index]) return null;
      const material = new THREE.MeshBasicMaterial({ color: color(name, index), transparent: true, opacity: name === "glass" ? 0.22 : 0.38, depthWrite: false });
      const mesh = new THREE.InstancedMesh(cube, material, counts[index]);
      mesh.renderOrder = 10;
      mesh.userData.next = 0;
      group.add(mesh);
      return mesh;
    });
    const matrix = new THREE.Matrix4();
    for (let i = 0; i + 3 < preview.blocks.length; i += 4) {
      const mesh = meshes[preview.blocks[i + 3]];
      if (!mesh) continue;
      matrix.makeTranslation(preview.blocks[i] + 0.5, preview.blocks[i + 1] + 0.5, preview.blocks[i + 2] + 0.5);
      mesh.setMatrixAt(mesh.userData.next++, matrix);
    }
    for (const mesh of meshes) if (mesh) mesh.instanceMatrix.needsUpdate = true;
    const f = preview.footprint;
    if (f) {
      const y = f.minY + 0.03;
      const corners = [[f.minX, f.minZ], [f.maxX + 1, f.minZ], [f.maxX + 1, f.maxZ + 1], [f.minX, f.maxZ + 1]];
      const points = [];
      corners.forEach((corner, i) => {
        const next = corners[(i + 1) % 4];
        points.push(new THREE.Vector3(corner[0], y, corner[1]), new THREE.Vector3(next[0], y, next[1]));
      });
      const outline = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }));
      outline.renderOrder = 11;
      group.add(outline);
      const facing = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[preview.facing];
      if (facing) {
        const cx = (f.minX + f.maxX + 1) / 2, cz = (f.minZ + f.maxZ + 1) / 2;
        const edge = new THREE.Vector3(cx + facing[0] * (f.maxX + 1 - f.minX) / 2, y + 0.5, cz + facing[1] * (f.maxZ + 1 - f.minZ) / 2);
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(facing[0], 0, facing[1]), edge, 3, 0xffd166, 1, 0.6);
        arrow.traverse((node) => { if (node.material) { node.material.depthTest = false; node.material.transparent = true; } node.renderOrder = 11; });
        group.add(arrow);
      }
    }
    scene.add(group);
  }
  window.addEventListener("bob-preview", (event) => show(event.detail));
  return { show, clear };
}
