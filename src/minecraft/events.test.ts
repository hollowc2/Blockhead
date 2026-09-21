import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeterministicBuildCommand, parseDeterministicTerrainCommand } from "./events.js";

test("terrain phrases map to bounded tools without an LLM call", () => {
  assert.deepEqual(parseDeterministicTerrainCommand("flatten 10x10 here"), { tool: "flatten_area", args: { width: 10, length: 10, anchor: "owner" } });
  assert.deepEqual(parseDeterministicTerrainCommand("clear 20x15 here"), { tool: "clear_area", args: { width: 20, length: 15, height: 4, anchor: "owner" } });
  assert.deepEqual(parseDeterministicTerrainCommand("dig a 10x10 hole 5 blocks deep"), { tool: "excavate_volume", args: { width: 10, length: 10, depth: 5, anchor: "owner" } });
  assert.deepEqual(parseDeterministicTerrainCommand("dig a mineshaft down to Y=-40"), { tool: "dig_mineshaft", args: { width: 1, height: 2, targetY: -40, anchor: "owner_front" } });
  assert.deepEqual(parseDeterministicTerrainCommand("dig a two-wide staircase down 30 blocks"), { tool: "dig_mineshaft", args: { width: 2, height: 2, depth: 30, anchor: "owner_front" } });
});

test("standard shed command has a deterministic LLM-independent route", () => {
  assert.deepEqual(parseDeterministicBuildCommand("please build a standard stockpile shed"), {
    tool: "build_base",
    args: {},
  });
});

test("custom pyramid command is parsed and impossible height is explained", () => {
  assert.deepEqual(
    parseDeterministicBuildCommand("build a pyramid 15 wide 8 tall 15 long at home"),
    { tool: "build_structure", args: { shape: "pyramid", width: 15, height: 8, length: 15, material: "planks", anchor: "home" } },
  );
  assert.deepEqual(
    parseDeterministicBuildCommand("i want a stockpile shed shaped like a pyramid 15 wide 15 tall 15 long"),
    { tool: "build_structure", args: {}, error: "a 15 by 15 stepped pyramid can be at most 8 blocks tall" },
  );
});

test("common structure requests get bounded deterministic defaults", () => {
  assert.deepEqual(parseDeterministicBuildCommand("build me a house"), {
    tool: "build_structure",
    args: { shape: "room", width: 7, height: 4, length: 7, material: "planks", anchor: "owner" },
  });
  assert.deepEqual(parseDeterministicBuildCommand("make a tower 5x8x5 at home"), {
    tool: "build_structure",
    args: { shape: "tower", width: 5, height: 8, length: 5, material: "planks", anchor: "home" },
  });
});

test("landmark chat requests use the same validated design tool", () => {
  assert.deepEqual(parseDeterministicBuildCommand("build the Pentagon"), {
    tool: "build_design", args: { template: "pentagon_complex", scale: "medium", anchor: "owner" },
  });
  assert.deepEqual(parseDeterministicBuildCommand("build a medium Sears Tower-inspired skyscraper"), {
    tool: "build_design", args: { template: "bundled_tube_skyscraper", scale: "medium", anchor: "owner" },
  });
});
