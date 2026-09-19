# CobbleBob declarative building

CobbleBob has two construction routes. `build_structure` remains the small,
backward-compatible route for rooms, walls, towers, and pyramids. `build_design`
is the architecture route:

`chat/LLM -> BuildingDesign (Zod) -> semantic validation -> deterministic compiler -> persisted build_design task -> resumable placement`

The model selects a named template or a composition of supported primitives. It
never emits JavaScript, Minecraft commands, or a block-coordinate list. The
compiler expands components into stable operation IDs, sorts them by phase and
support order, deduplicates cells, detects structural conflicts, and estimates
materials. The task stores the validated design and resolved origin, so a
reconnect resumes the same design rather than asking the model again.

## Schema and primitives

`src/building/schema.ts` defines `BuildingDesign`: name, description, anchor,
orientation, scale, palette, components, and optional decoration settings.
Components include cuboids, polygon prisms, towers, bundled towers, walls,
floors, roofs, window patterns, doors, arches, columns, stair steps, interior
zones, and decorations. Components can have bounded translation, 90-degree
rotation, repetition, mirroring, and vertical stacking.

To add a primitive, add one discriminated Zod branch, add its deterministic
expansion in `src/building/compiler.ts`, and add geometry/limit tests. Do not
add an execution path that consumes model-generated code.

## Templates and commands

Templates currently include `pentagon_complex`, `bundled_tube_skyscraper`,
castle, cathedral, mansion, greenhouse, bridge, and museum. Pentagon is a
scaled low-rise five-sided complex with nested rings, open courtyard, radial
corridors, windows, lighting, and accents. Bundled tube is a nine-square,
setback, dark-shell interpretation of the Sears/Willis Tower family.

Examples:

- `CobbleBob, build the Pentagon.`
- `CobbleBob, build a medium Sears Tower-inspired skyscraper.`
- `CobbleBob, build a castle with four corner towers.`
- `CobbleBob, build a futuristic glass museum with colorful interiors.`

Obvious landmark phrases are recognized before the LLM and enqueue the same
validated task. Otherwise the decision prompt exposes `build_design`; simple
room/wall/tower/pyramid requests continue using `build_structure`.

## Safety limits

The `building` configuration section controls maximum width, depth, height,
operation count, component count, anchor distance, approved materials, and
creative demolition. Defaults are 64 x 64 x 64, 12,000 operations, 64
components, and 128 blocks from home. Survival mode never demolishes an
unexpected occupied cell. Creative demolition is still limited to the approved
footprint and passes through the existing world-action/protection policy.

Material roles resolve through the deterministic palette. Creative mode obtains
approved blocks through the existing creative inventory adapter. Survival mode
uses carried exact materials and returns a partial, actionable shortage when a
required material is unavailable; glass, doors, and lighting are not silently
replaced with planks.
