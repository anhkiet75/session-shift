#!/usr/bin/env node
import fs from "fs";
import path from "path";
import * as esbuild from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const WATCH_DIRS = [
  path.join(SRC, "background"),
  path.join(SRC, "lib"),
  path.join(SRC, "popup"),
];

function tsFilesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

function getEntryPoints() {
  return [
    ...tsFilesIn(path.join(SRC, "background")),
    ...tsFilesIn(path.join(SRC, "lib")),
    path.join(SRC, "content.ts"),
    path.join(SRC, "page-api-proxy.ts"),
    path.join(SRC, "options", "options.ts"),
    ...tsFilesIn(path.join(SRC, "popup")),
  ].filter((f) => fs.existsSync(f));
}

let ctx = null;
let restarting = false;

async function startContext() {
  if (ctx) await ctx.dispose();
  const entries = getEntryPoints();
  console.log(`[esbuild] watching ${entries.length} entry points`);
  ctx = await esbuild.context({
    entryPoints: entries,
    bundle: false,
    format: "esm",
    platform: "browser",
    outbase: SRC,
    outdir: DIST,
  });
  await ctx.watch();
}

// Restart when a new .ts file is added to a watched directory
for (const dir of WATCH_DIRS) {
  if (!fs.existsSync(dir)) continue;
  fs.watch(dir, async (event, filename) => {
    if (!filename || !filename.endsWith(".ts") || event !== "rename") return;
    if (restarting) return;
    restarting = true;
    console.log(`[esbuild] new file detected (${filename}), restarting context...`);
    await startContext().catch((e) => console.error("[esbuild] restart error:", e.message));
    restarting = false;
  });
}

await startContext();
