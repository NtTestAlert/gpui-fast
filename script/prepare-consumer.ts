#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "smol-toml";
import { DEST, ROOT, fastName, readToml } from "./release-common";

export function prepareConsumer(dest: string, distribution = DEST, sourcePatches = false, root = ROOT, capture = false): void {
  const output = relative(resolve(root), resolve(dest)).replaceAll("\\", "/");
  if (isAbsolute(output) || !output.startsWith("target/")) {
    throw new Error("Consumer output must be inside target/ in this checkout");
  }
  const generated = readToml(resolve(distribution, "Cargo.toml"));
  const source = generated.workspace.metadata["gpui-fast-fork"];
  const fast = Object.fromEntries(generated.workspace.members.map((name: string) => [
    fastName(name), { path: resolve(distribution, name) },
  ]));
  const patches = sourcePatches ? structuredClone(source.registry_patches) : {};
  patches["crates-io"] = { ...(patches["crates-io"] ?? {}), ...fast };
  mkdirSync(resolve(dest, "src"), { recursive: true });
  writeFileSync(resolve(dest, "Cargo.toml"), stringify({
    package: { name: "fast-distribution-consumer", version: "0.0.0", edition: "2024", publish: false },
    workspace: {},
    dependencies: {
      gpui: { package: "gpui-kit", version: "=0.9.1", "default-features": false, features: ["gpui-fast"] },
      "gpui-component": { version: "=0.9.1", features: ["gpui-fast"] },
      ...(capture ? {
        gpui_platform: { package: "gpui-fast-platform", path: resolve(distribution, "gpui_platform"), "default-features": false },
        gpui_fast_core: { package: "gpui-fast", path: resolve(distribution, "gpui"), "default-features": false },
      } : {}),
    },
    ...(capture ? { features: { "screen-capture": ["gpui_fast_core/screen-capture", "gpui_platform/screen-capture"] } } : {}),
    patch: patches,
  }));
  writeFileSync(resolve(dest, "src/lib.rs"),
    "use gpui::IntoElement;\n"
    + "pub fn component_identity(button: gpui_component::button::Button) -> gpui::AnyElement {\n"
    + "    button.into_any_element()\n}\n");
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    dest: { type: "string" }, distribution: { type: "string" }, "source-patches": { type: "boolean" }, capture: { type: "boolean" },
  } });
  if (!values.dest) throw new Error("--dest target/consumer-name is required");
  prepareConsumer(resolve(ROOT, values.dest), values.distribution ? resolve(ROOT, values.distribution) : DEST,
    values["source-patches"] ?? false, ROOT, values.capture ?? false);
}
