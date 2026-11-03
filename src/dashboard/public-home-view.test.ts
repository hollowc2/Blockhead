import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { blockColour, botHomeViewWorld, cachedHomeView, encodePng, HOME_VIEW_RADIUS, HOME_VIEW_SIZE, renderHomeView, type HomeViewWorld } from "./public-home-view.js";

const HOME = { x: 123457.4, y: 71.2, z: -98765.7 };

/**
 * A small hand-made scene around home, given relative to home's block and
 * placed at (ox, oy, oz) in the world: a grass field with a stone house,
 * a sign, a chest, a pond, a tree, torches and glass. Anything outside it is air.
 */
function scene(ox = 0, oy = 0, oz = 0, unloaded: (x: number, z: number) => boolean = () => false): HomeViewWorld & { calls: number } {
  const hx = Math.floor(HOME.x) + ox, hy = Math.floor(HOME.y) + oy, hz = Math.floor(HOME.z) + oz;
  const relative = (dx: number, dy: number, dz: number): string => {
    if (Math.abs(dx) <= 3 && Math.abs(dz) <= 3) {
      if (dy === 3) return dx === 0 && dz === 0 ? "glass" : "cobblestone";
      if (dy === 0 && dx === 1 && dz === 1) return "chest";
      if (dy === 1 && dx === -2 && dz === 0) return "oak_wall_sign";
      if (dy === 1 && dx === 2 && dz === 2) return "wall_torch";
      if (dy === -1) return "oak_planks";
      return "air";
    }
    if (dx >= 6 && dx <= 10 && dz >= -8 && dz <= -4) { if (dy <= -1 && dy >= -3 - (dx - 6)) return "water"; if (dy < -1) return "dirt"; return "air"; }
    if (dx === -8 && dz === 6) { if (dy >= 0 && dy <= 4) return "oak_log"; }
    if (Math.abs(dx + 8) <= 2 && Math.abs(dz - 6) <= 2 && dy >= 4 && dy <= 6) return "oak_leaves";
    if (dy === 0 && (dx * 7 + dz * 3) % 11 === 0) return "short_grass";
    if (dy === -1) return dx > 14 ? "sand" : "grass_block";
    if (dy < -1) return "dirt";
    return "air";
  };
  const world = {
    calls: 0,
    loaded: (x: number, z: number) => !unloaded(x - hx, z - hz),
    block(x: number, y: number, z: number) { world.calls++; return relative(x - hx, y - hy, z - hz); },
  };
  return world;
}

/** The PNG's chunk types in order, and its pixels as RGB rows. */
function decode(png: Buffer): { chunks: string[]; width: number; height: number; pixel: (x: number, y: number) => [number, number, number] } {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: string[] = [];
  let idat = Buffer.alloc(0), width = 0, height = 0;
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8), data = png.subarray(at + 8, at + 8 + length);
    chunks.push(type);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]); }
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    at += 12 + length;
  }
  const rows = inflateSync(idat);
  return {
    chunks, width, height,
    pixel: (x, y) => { const at = y * (width * 3 + 1) + 1 + x * 3; assert.equal(rows[y * (width * 3 + 1)], 0); return [rows[at]!, rows[at + 1]!, rows[at + 2]!]; },
  };
}

test("the picture is a bare 39×39 RGB PNG: no text, time or any other chunk", () => {
  const png = renderHomeView(scene(), HOME);
  assert(png !== null);
  const image = decode(png);
  assert.deepEqual(image.chunks, ["IHDR", "IDAT", "IEND"]);
  assert.equal(image.width, HOME_VIEW_SIZE);
  assert.equal(image.height, HOME_VIEW_SIZE);
  assert.equal(HOME_VIEW_SIZE, 2 * HOME_VIEW_RADIUS + 1);
  // Nothing printable that could be a coordinate, a name or an address hides in the bytes.
  const text = png.toString("latin1");
  for (const piece of ["123457", "98765", "tEXt", "iTXt", "zTXt", "tIME", "eXIf", "Home", "sign", "chest"]) assert.equal(text.includes(piece), false, piece);
  assert(png.length < 8192, `${png.length} bytes`);
});

test("the same scene anywhere in the world (any x, y or z) encodes to the same bytes", () => {
  const reference = renderHomeView(scene(), HOME);
  assert(reference !== null);
  for (const [ox, oy, oz] of [[1, 0, 0], [0, 0, -1], [7, 3, -9], [-15, -40, 15], [16, 0, 16], [-123457, 0, 98765], [4_000_001, 120, -2_999_999]] as const) {
    const moved = { x: HOME.x + ox, y: HOME.y + oy, z: HOME.z + oz };
    assert.deepEqual(renderHomeView(scene(ox, oy, oz), moved), reference, `${ox},${oy},${oz}`);
  }
  // A fractional home inside the same block changes nothing either.
  assert.deepEqual(renderHomeView(scene(), { x: Math.floor(HOME.x) + 0.99, y: Math.floor(HOME.y), z: Math.floor(HOME.z) + 0.01 }), reference);
});

test("it draws only block colours: the roof hides the chest and the sign, glass shows the floor, grass tufts don't speckle", () => {
  const image = decode(renderHomeView(scene(), HOME)!);
  const at = (dx: number, dz: number) => image.pixel(HOME_VIEW_RADIUS + dx, HOME_VIEW_RADIUS + dz);
  const roof = at(1, 1);
  assert.deepEqual(at(-2, 0), roof, "sign under the roof: roof");
  assert.deepEqual(at(2, 2), roof, "torch under the roof: roof");
  // Through the glass at the centre: the planks floor, a wood colour.
  const centre = at(0, 0);
  assert(centre[0] > centre[2] + 30, `planks through the glass ${centre}`);
  // The pond is blue and deeper water darker; the field is green.
  const shallow = at(6, -6), deep = at(10, -6);
  assert(shallow[2] > shallow[0] + 100 && deep[2] < shallow[2], `${shallow} ${deep}`);
  const field = at(-15, -15);
  assert(field[1] > field[0] && field[1] > field[2], `field ${field}`);
  // A tuft on the field reads as the field.
  let tuft: [number, number] | null = null;
  for (let dx = -18; dx <= -12 && !tuft; dx++) for (let dz = -18; dz <= -12 && !tuft; dz++) if ((dx * 7 + dz * 3) % 11 === 0) tuft = [dx, dz];
  assert(tuft !== null);
  const [r, g, b] = at(...tuft);
  assert(g > r && g > b);
  // Leaves are darker green than grass.
  assert(at(-8, 6)[1] < field[1]);
});

test("only block names are read: signs and containers give nothing but their colour", () => {
  assert.deepEqual(blockColour("oak_wall_sign"), blockColour("oak_planks"));
  assert.deepEqual(blockColour("chest"), blockColour("oak_planks"));
  assert.equal(blockColour("air"), null);
  assert.equal(blockColour("red_stained_glass_pane"), null);
  assert.deepEqual(blockColour("an_unknown_modded_block"), blockColour("stone"));
  // The world interface has two functions and nothing else: no entities, no block entities, no players.
  const world = scene();
  assert.deepEqual(Object.keys(world).filter((key) => key !== "calls").sort(), ["block", "loaded"]);
});

test("no picture unless every column it needs is loaded, so chunk edges never show", () => {
  for (const [dx, dz] of [[HOME_VIEW_RADIUS, 0], [-HOME_VIEW_RADIUS, HOME_VIEW_RADIUS], [0, -HOME_VIEW_RADIUS - 1], [0, 0]] as const) {
    assert.equal(renderHomeView(scene(0, 0, 0, (x, z) => x === dx && z === dz), HOME), null, `${dx},${dz}`);
  }
  assert.equal(renderHomeView(scene(), { x: Number.NaN, y: 64, z: 0 }), null);
});

test("a render is cheap: bounded block reads", () => {
  const world = scene();
  const started = performance.now();
  renderHomeView(world, HOME);
  const columns = HOME_VIEW_SIZE * (HOME_VIEW_SIZE + 1);
  assert(world.calls <= columns * 67, `${world.calls} reads`);
  assert(performance.now() - started < 500);
});

test("cachedHomeView never renders in the request, renders at most once per refresh while asked, and keeps the last picture", async () => {
  let clock = 0, sources = 0;
  let current: { home: typeof HOME | null; world: HomeViewWorld | null } = { home: HOME, world: scene() };
  const view = cachedHomeView(() => { sources++; return current; }, { refreshMs: 90_000, retryMs: 15_000, now: () => clock });
  const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.equal(view(), null, "the first ask only starts a render");
  assert.equal(sources, 0, "nothing is read during the request");
  await settle();
  const first = view();
  assert(first !== null);
  // Hundreds of asks within the refresh window: no new render.
  for (let i = 0; i < 300; i++) { clock += 100; view(); }
  await settle();
  assert.equal(sources, 1);
  clock = 90_000;
  view();
  await settle();
  assert.equal(sources, 2);
  // Far from home (columns unloaded) or in another dimension (no home): the last picture stays.
  current = { home: HOME, world: scene(0, 0, 0, () => true) };
  clock += 90_000; view(); await settle();
  current = { home: null, world: null };
  clock += 90_000; view(); await settle();
  assert.deepEqual(view(), first);
  // A different home drops it; with no picture the retry is sooner.
  current = { home: { x: HOME.x + 500, y: HOME.y, z: HOME.z }, world: null };
  clock += 90_000; view(); await settle();
  assert.equal(view(), null);
  const before = sources;
  clock += 15_000; view(); await settle();
  assert.equal(sources, before + 1);
  // A failing source is reported, not thrown at the request.
  const errors: unknown[] = [];
  const failing = cachedHomeView(() => { throw new Error("db at x=123457"); }, { now: () => 0, onError: (error) => errors.push(error) });
  assert.equal(failing(), null);
  await settle();
  assert.equal(errors.length, 1);
});

test("botHomeViewWorld reads only loaded columns and block-state names", () => {
  const world = botHomeViewWorld({
    world: { getColumnAt: (pos: { x: number }) => (pos.x >= 0 ? {} : undefined), getBlockStateId: (pos: { y: number }) => (pos.y > 64 ? 0 : 1) },
    registry: { blocksByStateId: { 0: { name: "air" }, 1: { name: "stone" } } },
  } as never);
  assert.equal(world.loaded(5, 5), true);
  assert.equal(world.loaded(-5, 5), false);
  assert.equal(world.block(0, 70, 0), "air");
  assert.equal(world.block(0, 60, 0), "stone");
});

test("encodePng writes a valid image", () => {
  const png = encodePng(2, 1, Buffer.from([255, 0, 0, 0, 0, 255]));
  const image = decode(png);
  assert.deepEqual(image.pixel(0, 0), [255, 0, 0]);
  assert.deepEqual(image.pixel(1, 0), [0, 0, 255]);
});
