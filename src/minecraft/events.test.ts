import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeterministicBuildCommand } from "./events.js";

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
