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
