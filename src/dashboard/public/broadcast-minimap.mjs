// The broadcast's minimap panel: polls /api/public/minimap every 5 s and
// draws a north-up, terrain-free SVG in the `minimap` slot (the trail, Bob's
// heading arrow, home or an arrow toward it on the rim). The server sends
// only small relative integers (src/dashboard/public-minimap.ts); this file
// clamps them again and never draws a number, label or scale. Colours are
// the page's tokens (broadcast.css) as presentation attributes, since the
// CSP allows no inline style.
const SVG = "http://www.w3.org/2000/svg";
const POLL_MS = 5000, DEADLINE_MS = 4000;
const COLORS = { disc: "#12181d", rim: "#3b4954", north: "#a3b2be", trail: "#2ee6f0", bob: "#e6edf2", bobEdge: "#1d252c", home: "#3ccf7e" };
const MAX_RADIUS = 16, BEARINGS = 16;

const int = (value, limit) => Number.isInteger(value) && Math.abs(value) <= limit ? value : null;
const cell = (value, radius) => {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, z] = [int(value[0], radius), int(value[1], radius)];
  return x === null || z === null || x * x + z * z > radius * radius ? null : [x, z];
};

/**
 * What to draw, in cell units around Bob at (0, 0), +x east and +y south; or
 * null for anything malformed. Rotations are degrees clockwise from north.
 */
export function minimapShapes(data) {
  if (data === null || typeof data !== "object") return null;
  const radius = int(data.radius, MAX_RADIUS);
  const heading = int(data.heading, BEARINGS - 1);
  if (radius === null || radius < 1 || heading === null || heading < 0 || !Array.isArray(data.trail)) return null;
  const trail = data.trail.slice(-64).map((point) => cell(point, radius)).filter((point) => point !== null);
  let home = null;
  if (data.home && typeof data.home === "object") {
    const at = cell(data.home.at, radius);
    const bearing = int(data.home.bearing, BEARINGS - 1);
    if (at !== null) home = { x: at[0], y: at[1] };
    else if (bearing !== null && bearing >= 0) home = { rim: bearing * (360 / BEARINGS) };
  }
  return { radius, heading: heading * (360 / BEARINGS), trail: trail.length > 1 ? trail.map(([x, y]) => `${x},${y}`).join(" ") : null, home };
}

function node(tag, attributes, parent) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  parent?.appendChild(element);
  return element;
}
// A house: a roof over a square, about two cells across, so it survives 480p.
const HOUSE = "M0,-2.1 L2.1,-0.3 L1.4,-0.3 L1.4,1.7 L-1.4,1.7 L-1.4,-0.3 L-2.1,-0.3 Z";
// Bob: an arrowhead pointing north before rotation.
const ARROW = "M0,-3 L2.2,2.2 L0,1 L-2.2,2.2 Z";

/** Builds the panel inside `slot` and keeps it current; the slot is hidden while there is nothing to show. */
export function mountMinimap(slot) {
  if (!slot) return;
  slot.hidden = true;
  const heading = document.createElement("h2");
  heading.textContent = "Map";
  const svg = node("svg", { width: "100%", height: 140, preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" });
  slot.replaceChildren(heading, svg);
  let drawn = null;

  function draw(shapes) {
    const extent = shapes.radius + 2;
    svg.setAttribute("viewBox", `${-extent} ${-extent} ${extent * 2} ${extent * 2}`);
    const rim = shapes.radius + 0.5;
    svg.replaceChildren();
    node("circle", { r: rim, fill: COLORS.disc, stroke: COLORS.rim, "stroke-width": 0.4 }, svg);
    // North marker: a small notch at the top of the rim.
    node("path", { d: `M0,${-rim - 1.2} L0.9,${-rim + 0.4} L-0.9,${-rim + 0.4} Z`, fill: COLORS.north }, svg);
    if (shapes.trail !== null) {
      node("polyline", { points: shapes.trail, fill: "none", stroke: COLORS.trail, "stroke-width": 0.9, "stroke-opacity": 0.8, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
    }
    if (shapes.home !== null && "rim" in shapes.home) {
      // Home is out of range: a house just inside the rim and a pointer on it, toward home.
      const group = node("g", { transform: `rotate(${shapes.home.rim})` }, svg);
      node("path", { d: `M0,${-rim - 1.4} L1.3,${-rim + 0.6} L-1.3,${-rim + 0.6} Z`, fill: COLORS.home }, group);
      node("path", { d: HOUSE, fill: COLORS.home, transform: `translate(0,${-rim + 3.4}) rotate(${-shapes.home.rim})` }, group);
    } else if (shapes.home !== null) {
      node("path", { d: HOUSE, fill: COLORS.home, transform: `translate(${shapes.home.x},${shapes.home.y})` }, svg);
    }
    node("path", { d: ARROW, fill: COLORS.bob, stroke: COLORS.bobEdge, "stroke-width": 0.35, "stroke-linejoin": "round", transform: `rotate(${shapes.heading})` }, svg);
  }

  let busy = false;
  async function poll() {
    if (busy || document.hidden) return;
    busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      const response = await fetch("/api/public/minimap", { cache: "no-store", signal: controller.signal });
      const shapes = response.ok ? minimapShapes(await response.json()) : null;
      if (shapes === null) { slot.hidden = true; drawn = null; return; }
      const signature = JSON.stringify(shapes);
      if (signature !== drawn) { draw(shapes); drawn = signature; }
      slot.hidden = false;
    } catch {
      slot.hidden = true; drawn = null;
    } finally {
      clearTimeout(timer); busy = false;
    }
  }
  void poll();
  setInterval(() => void poll(), POLL_MS);
}
