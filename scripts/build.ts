import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { rm, readFile } from "node:fs/promises"
import path from "node:path"

const directory = path.resolve(process.argv[2] ?? ".")
await rm(path.join(directory, "dist"), { recursive: true, force: true })
const tsx = path.join(directory, "src/index.tsx")
const indexEntry = (await Bun.file(tsx).exists()) ? tsx : path.join(directory, "src/index.ts")
const tuiEntry = path.join(directory, "src/tui.tsx")
const result = await Bun.build({
  entrypoints: [indexEntry, tuiEntry],
  outdir: path.join(directory, "dist"),
  target: "bun",
  format: "esm",
  plugins: [createSolidTransformPlugin()],
  external: [
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/core-*",
    "@opentui/keymap",
    "@opentui/solid",
    "solid-js",
    "solid-js/store",
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// The host skips transforms under node_modules: dist/tui.js must be
// pre-compiled (reactive insert, no JSX runtime) or published installs freeze.
const tuiOut = result.outputs.find((emitted) => emitted.path.endsWith(path.join("dist", "tui.js")))
const tuiCode = (tuiOut && (await readFile(tuiOut.path, "utf8"))) || ""
if (!/insert\(/.test(tuiCode) || /jsx/.test(tuiCode)) {
  console.error("dist/tui.js was not pre-compiled with the Solid transform")
  process.exit(1)
}