/** Extend the upstream entity renderer with textured dropped stacks. */
export function installViewerDroppedItems(THREE, entities, itemTextures, loadBlockStates = () => fetch("blocksStates/1.21.4.json").then(response => {
  if (!response.ok) throw new Error("Block models unavailable");
  return response.json();
})) {
  const update = entities.update.bind(entities);
  const clear = entities.clear.bind(entities);
  const drops = new Map();
  const textures = new Map();
  let blockStates = {};

  function texture(path, atlas = false) {
    if (!textures.has(path)) {
      const map = new THREE.TextureLoader().load(path);
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      map.flipY = !atlas;
      textures.set(path, map);
    }
    return textures.get(path);
  }

  function dispose(group) {
    for (const child of [...group.children]) {
      child.traverse(part => { part.geometry?.dispose(); part.material?.dispose(); });
      group.remove(child);
    }
  }

  function blockModel(name) {
    const variants = Object.entries(blockStates[name]?.variants ?? {});
    // Pick the normal inventory orientation for logs, slabs and stairs.
    const normal = variants.find(([key]) => !/axis=[xz]|type=(top|double)|half=top|shape=(inner|outer)|snowy=true/.test(key)) ?? variants[0];
    const variant = normal?.[1];
    return (Array.isArray(variant) ? variant[0] : variant)?.model;
  }

  function render(drop) {
    const { group, name } = drop;
    dispose(group);
    group.visible = false;
    if (!name || !/^[a-z0-9_]+$/.test(name)) return;
    const path = itemTextures[name];
    if (!path) return;
    const block = path.startsWith("blocks/");
    const model = block ? blockModel(name) : null;
    if (model?.elements?.length) {
      const faces = ["east", "west", "up", "down", "south", "north"];
      for (const [elementIndex, element] of model.elements.entries()) {
        const size = element.to.map((v, i) => (v - element.from[i]) / 64);
        const geometry = new THREE.BoxGeometry(...size);
        const originalIndices = Array.from(geometry.index.array);
        const indices = [];
        const colors = new Float32Array(24 * 3).fill(1);
        faces.forEach((face, i) => {
          const data = element.faces[face];
          if (!data) return;
          indices.push(...originalIndices.slice(i * 6, i * 6 + 6));
          const { u, v, su, sv } = data.texture;
          const angle = (data.rotation ?? 0) * Math.PI / 180;
          for (let corner = 0; corner < 4; corner++) {
            const x = corner % 2 - 0.5, y = (corner < 2 ? 0 : 1) - 0.5;
            const a = x * Math.cos(angle) + y * Math.sin(angle) + 0.5;
            const b = -x * Math.sin(angle) + y * Math.cos(angle) + 0.5;
            geometry.attributes.uv.setXY(i * 4 + corner, u + a * su, v + b * sv);
            if (data.tintindex !== undefined) colors.set([0.57, 0.74, 0.32], (i * 4 + corner) * 3);
          }
        });
        geometry.clearGroups();
        geometry.setIndex(indices);
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        const material = new THREE.MeshLambertMaterial({ map: texture("textures/1.21.4.png", true), vertexColors: true,
          transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, polygonOffset: elementIndex > 0, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(...element.from.map((v, i) => (v + element.to[i]) / 128 - (i === 1 ? 0 : 0.125)));
        if (element.rotation) {
          const { axis, angle, origin } = element.rotation;
          const pivot = new THREE.Group();
          pivot.position.set(...origin.map((v, i) => v / 64 - (i === 1 ? 0 : 0.125)));
          mesh.position.sub(pivot.position);
          pivot.rotation[axis] = angle * Math.PI / 180;
          pivot.add(mesh);
          group.add(pivot);
        } else group.add(mesh);
      }
    } else {
      const material = new THREE.MeshLambertMaterial({ map: texture(`textures/1.21.4/${path}`), transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(block ? new THREE.BoxGeometry(0.25, 0.25, 0.25) : new THREE.PlaneGeometry(0.35, 0.35), material);
      mesh.position.y = block ? 0.125 : 0.175;
      group.add(mesh);
    }
    group.visible = true;
  }

  entities.update = entity => {
    let drop = drops.get(entity.id);
    if (!drop && !["item", "Item", "item_stack"].includes(entity.name)) return update(entity);
    if (entity.delete) {
      if (drop) {
        dispose(drop.group);
        entities.scene.remove(drop.group);
        delete entities.entities[entity.id];
        drops.delete(entity.id);
      }
      return;
    }
    if (!drop) {
      const group = new THREE.Group();
      group.name = `dropped-item:${entity.id}`;
      group.visible = false;
      drop = { group, name: null };
      drops.set(entity.id, drop);
      entities.entities[entity.id] = group;
      entities.scene.add(group);
    }
    if (Object.hasOwn(entity, "itemName") && drop.name !== entity.itemName) {
      drop.name = entity.itemName;
      render(drop);
    }
    // Reuse upstream's movement interpolation; it now finds our textured mesh.
    update(entity);
  };

  entities.clear = () => {
    for (const [id, { group }] of drops) {
      dispose(group);
      entities.scene.remove(group);
      delete entities.entities[id];
    }
    drops.clear();
    for (const map of textures.values()) map.dispose();
    textures.clear();
    clear();
  };

  return Promise.resolve().then(loadBlockStates).then(states => {
    blockStates = states;
    for (const drop of drops.values()) render(drop);
  }).catch(() => {}); // Single-texture artwork remains usable if model data fails.
}
