#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const STATIC_COPY_MAP = [
  { src: path.join(SRC, "manifest.json"), dest: path.join(DIST, "manifest.json") },
  { src: path.join(SRC, "options", "options.html"), dest: path.join(DIST, "options", "options.html") },
  { src: path.join(SRC, "options", "options.css"), dest: path.join(DIST, "options", "options.css") },
  { src: path.join(SRC, "popup", "popup.html"), dest: path.join(DIST, "popup", "popup.html") },
  { src: path.join(SRC, "popup", "popup.css"), dest: path.join(DIST, "popup", "popup.css") },
];

const STATIC_COPY_DIRS = [
  { src: path.join(SRC, "icons"), dest: path.join(DIST, "icons") },
  { src: path.join(SRC, "popup", "fonts"), dest: path.join(DIST, "popup", "fonts") },
];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[static] copied ${path.relative(ROOT, src)}`);
}

// Watch individual static files
for (const { src, dest } of STATIC_COPY_MAP) {
  if (!fs.existsSync(src)) continue;
  fs.watch(src, () => {
    try { copyFile(src, dest); } catch (e) { console.error(`[static] error copying ${src}:`, e.message); }
  });
}

// Watch static dirs recursively
for (const { src, dest } of STATIC_COPY_DIRS) {
  if (!fs.existsSync(src)) continue;
  fs.watch(src, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const srcFile = path.join(src, filename);
    const destFile = path.join(dest, filename);
    try {
      if (fs.existsSync(srcFile)) copyFile(srcFile, destFile);
    } catch (e) {
      console.error(`[static] error copying ${srcFile}:`, e.message);
    }
  });
}

console.log("[static] watching HTML, CSS, JSON, icons, fonts...");
