#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEST, readToml } from "./release-common";
import { verifySourcePublication, type SourceProvenance } from "./release-provenance";

const { values } = parseArgs({
  args: Bun.argv.slice(2), options: { manifest: { type: "string" } },
});
const manifest = readToml(resolve(values.manifest ?? resolve(DEST, "Cargo.toml")));
const source = (manifest.workspace?.metadata ?? manifest.package?.metadata)?.["gpui-fast-fork"] as SourceProvenance;
if (!source) throw new Error("Manifest has no gpui-fast-fork provenance");
verifySourcePublication(source);
console.log("Verified source publication: " + source.source_url);
