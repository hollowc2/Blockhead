import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicLibrary, compatibleTracks, concatQuote, parseProbe, playlistText } from "./music.mjs";

const mp3 = (seconds = 120) => ({ codec: "mp3", sampleRate: 44100, channels: 2, seconds, layout: "a" });

function library(files, probes, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "music-test-"));
  for (const name of files) writeFileSync(join(dir, name), "x");
  let t = 0;
  const logs = [];
  const lib = new MusicLibrary({
    dir, playlistFile: join(dir, "playlist.ffconcat"), log: (msg, extra) => logs.push({ msg, ...extra }), now: () => t,
    probe: async path => probes[path.slice(dir.length + 1)] ?? null, random: () => 0, ...options,
  });
  return { lib, dir, logs, advance: ms => { t += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ffprobe output is reduced to codec, rate, channels, length and stream lineup", () => {
  const json = JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }, { codec_type: "video", codec_name: "mjpeg" }], format: { duration: "181.5" } });
  assert.deepEqual(parseProbe(json), { codec: "mp3", sampleRate: 44100, channels: 2, seconds: 181.5, layout: "a,v" });
  assert.equal(parseProbe("not json"), null);
  assert.equal(parseProbe({ streams: [{ codec_type: "video", codec_name: "mjpeg" }], format: { duration: "3" } }), null, "no audio stream");
  assert.equal(parseProbe({ streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "0", channels: 2 }], format: { duration: "3" } }), null);
});

test("only one decoder-compatible group of tracks is used", () => {
  const tracks = [
    { path: "/m/a.mp3", ...mp3() }, { path: "/m/b.mp3", ...mp3() },
    { path: "/m/c.ogg", ...mp3(), codec: "vorbis" },
    { path: "/m/d.mp3", ...mp3(), sampleRate: 48000 },
    { path: "/m/e.mp3", ...mp3(), layout: "a,v" },
  ];
  assert.deepEqual(compatibleTracks(tracks).map(t => t.path), ["/m/a.mp3", "/m/b.mp3"]);
  assert.deepEqual(compatibleTracks([]), []);
});

test("the playlist quotes paths, shuffles each round and repeats to cover the hours", () => {
  assert.equal(concatQuote("/m/it's.mp3"), "'/m/it'\\''s.mp3'");
  const text = playlistText([{ path: "/m/a.mp3", seconds: 1800 }, { path: "/m/b.mp3", seconds: 1800 }], { hours: 3, random: () => 0 });
  const lines = text.trim().split("\n");
  assert.equal(lines[0], "ffconcat version 1.0");
  assert.equal(lines.length - 1, 6, "3 h of 1 h rounds");
  assert.deepEqual(lines.slice(1, 3), ["file '/m/b.mp3'", "file '/m/a.mp3'"]);
  const capped = playlistText([{ path: "/m/a.mp3", seconds: 1 }], { hours: 168, maxEntries: 50 });
  assert.equal(capped.trim().split("\n").length - 1, 50, "entry cap");
});

test("without a directory or usable tracks the encoder keeps the silent track", async () => {
  const missing = new MusicLibrary({ dir: "/nonexistent/music", playlistFile: "/nonexistent/p", log: () => {}, probe: async () => mp3() });
  await missing.refresh();
  assert.equal(missing.forRun({ generation: 1 }), null);

  const { lib, cleanup } = library(["bad.mp3", "short.mp3", "cover.jpg", "notes.txt"], { "bad.mp3": null, "short.mp3": mp3(2) });
  try {
    await lib.refresh();
    assert.equal(lib.tracks.length, 0);
    assert.equal(lib.rejected, 2, "the corrupt and the too-short file; non-audio names are not probed");
    assert.equal(lib.forRun({ generation: 1 }), null);
  } finally { cleanup(); }

  const off = library(["a.mp3"], { "a.mp3": mp3() }, { enabled: false });
  try { await off.lib.refresh(); assert.equal(off.lib.forRun({ generation: 1 }), null); } finally { off.cleanup(); }
});

test("good tracks become a playlist; bad ones are skipped", async () => {
  const { lib, dir, cleanup } = library(["a.mp3", "b.mp3", "bad.mp3"], { "a.mp3": mp3(), "b.mp3": mp3() });
  try {
    await lib.refresh();
    const music = lib.forRun({ generation: 1 });
    assert.deepEqual(music, { list: join(dir, "playlist.ffconcat"), volume: 0.15 });
    const listed = readFileSync(music.list, "utf8");
    assert.ok(listed.includes("a.mp3") && listed.includes("b.mp3") && !listed.includes("bad.mp3"));
    assert.equal(lib.status().playing, true);
    // A track deleted after the scan is left out rather than failing ffmpeg's open.
    rmSync(join(dir, "a.mp3"));
    assert.ok(!readFileSync(lib.forRun({ generation: 2 }).list, "utf8").includes("a.mp3"));
  } finally { cleanup(); }
});

test("an early failure with music silences the next generations for a growing cool-off", async () => {
  const { lib, advance, logs, cleanup } = library(["a.mp3"], { "a.mp3": mp3() }, { cooloffMs: 1000, healthyRunMs: 60_000 });
  try {
    await lib.refresh();
    assert.ok(lib.forRun({ generation: 1, previous: null }));
    // Generation 1 died 5 s in: generation 2 runs silent.
    assert.equal(lib.forRun({ generation: 2, previous: { generation: 1, ranMs: 5_000, progressed: true } }), null);
    assert.ok(logs.some(l => l.msg === "music paused after an early encoder failure"));
    assert.equal(lib.status().pausedMinutes, 1);
    // The silent generation's own failure is not blamed on music.
    advance(500);
    assert.equal(lib.forRun({ generation: 3, previous: { generation: 2, ranMs: 100, progressed: false } }), null, "still cooling off");
    advance(600);
    assert.ok(lib.forRun({ generation: 4, previous: { generation: 3, ranMs: 100, progressed: false } }), "music back after the cool-off");
    // It fails again: the cool-off doubles.
    assert.equal(lib.forRun({ generation: 5, previous: { generation: 4, ranMs: 1_000, progressed: false } }), null);
    advance(1_500);
    assert.equal(lib.forRun({ generation: 6, previous: { generation: 5, ranMs: 1_000, progressed: false } }), null);
    advance(600);
    assert.ok(lib.forRun({ generation: 7, previous: { generation: 6, ranMs: 1_000, progressed: false } }));
    // A long, healthy music run ending (e.g. a network drop) keeps music and resets the cool-off.
    assert.ok(lib.forRun({ generation: 8, previous: { generation: 7, ranMs: 3_600_000, progressed: true } }));
    assert.equal(lib.trips, 0);
  } finally { cleanup(); }
});

test("volume is clamped and a bad value falls back to the default", () => {
  assert.equal(new MusicLibrary({ dir: "/x", playlistFile: "/x/p", volume: 7 }).o.volume, 1);
  assert.equal(new MusicLibrary({ dir: "/x", playlistFile: "/x/p", volume: Number("loud") }).o.volume, 0.15);
});
