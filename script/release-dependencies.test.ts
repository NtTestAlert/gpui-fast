import { expect, test } from "bun:test";
import { dependency } from "./prepare-release";
import { readConfig } from "./release-common";
import { pinnedPatches, validateCaptureRequirement, verifyGpuDependencies } from "./release-dependencies";

const config = readConfig();
const revision = "cddb2f5d80dc0009b2ef6767635140cacf90a007";

function patchFixture() {
  const declared = {
    "async-process": { git: "https://github.com/zed-industries/async-process.git", rev: "0".repeat(40) },
    "async-task": { git: "https://github.com/zed-industries/async-task.git", rev: "1".repeat(40) },
    "windows-capture": { git: "https://github.com/zed-industries/windows-capture.git", rev: "2".repeat(40) },
    calloop: { git: "https://github.com/zed-industries/calloop" },
    "khronos-egl": { git: "https://github.com/zed-industries/khronos-egl", rev: "4".repeat(40) },
  };
  const wasm = { git: "https://github.com/zed-industries/wasm_thread", rev: "5".repeat(40) };
  const manifest = {
    patch: { "crates-io": declared }, workspace: { dependencies: { wasm_thread: wasm } },
  };
  const packages = [...Object.entries(declared), ["wasm_thread", wasm] as const]
    .map(([name, value], i) => ({
      name, version: name === "calloop" ? "0.14.3" : name === "windows-capture" ? "1.4.3" : "1.0.0",
      source: "git+" + value.git + "#" + ("rev" in value ? value.rev : String(i).repeat(40)),
    }));
  return { manifest, lock: { package: packages } };
}

test("distribution transports five locked source patches and the matching Web worker patch", () => {
  const { manifest, lock } = patchFixture();
  const result = pinnedPatches(manifest, lock);
  expect(Object.keys(result.patches["crates-io"])).toHaveLength(6);
  expect(result.patches["crates-io"].calloop.rev).toBe("3".repeat(40));
  expect(result.patches["crates-io"].wasm_thread.rev).toBe("5".repeat(40));
  expect(result.versions["windows-capture"]).toBe("1.4.3");
  expect(manifest.patch["crates-io"].calloop).not.toHaveProperty("rev");
});

test("patch transport rejects missing, ambiguous and mismatched source lock revisions", () => {
  const { manifest, lock } = patchFixture();
  expect(() => pinnedPatches(manifest, { package: [] })).toThrow("Missing or ambiguous");
  expect(() => pinnedPatches(manifest, { package: [...lock.package, lock.package[0]] }))
    .toThrow("Missing or ambiguous");
  const changed = structuredClone(lock);
  changed.package[0].source = changed.package[0].source.replace(/#.+$/, "#" + "9".repeat(40));
  expect(() => pinnedPatches(manifest, changed)).toThrow("differs from its lock entry");
});

test("default shared registry requirements retain their source ranges and flags", () => {
  const input = { version: "0.14.3", optional: true, features: ["futures"] };
  expect(dependency("calloop", input, {}, config, "0.1.14")).toEqual(input);
  expect(dependency("async-task", "4.7", {}, config, "0.1.14")).toBe("4.7");
  expect(dependency("windows-capture", "1.3.6", {}, config, "0.1.14")).toBe("1.3.6");
});

test("capture compatibility range admits five-argument releases and rejects the 1.5 API", () => {
  const range = config.windows_capture_requirement.replaceAll(",", "");
  for (const version of ["1.3.6", "1.4.2", "1.4.3", "1.4.4"]) {
    expect(Bun.semver.satisfies(version, range)).toBe(true);
  }
  expect(Bun.semver.satisfies("1.5.0", range)).toBe(false);
  validateCaptureRequirement(config.windows_capture_requirement, "1.4.3");
  expect(() => validateCaptureRequirement(undefined, "1.4.3")).toThrow("must be configured");
  expect(() => validateCaptureRequirement("", "1.4.3")).toThrow("must be configured");
  expect(() => validateCaptureRequirement("<1.4.0", "1.4.3")).toThrow("must admit");
  expect(() => validateCaptureRequirement(">=1.3.6", "1.4.3")).toThrow("must reject");
  expect(() => validateCaptureRequirement("1.4", "1.4.3")).toThrow("explicit comparators");
  expect(() => validateCaptureRequirement(">=1.3.6, <1.5", "1.4.3")).toThrow("full versions");
});

test("all direct Git dependencies retain immutable source identity and flags", () => {
  for (const key of ["wgpu", "naga", "wgpu-core", "wasm_thread", "font-kit", "scap", "xim"]) {
    const input = { git: "https://example.invalid/" + key, rev: revision,
      version: "1", optional: true, "default-features": false, features: ["fixture"] };
    expect(dependency(key, input, {}, config, "0.1.14")).toEqual(input);
    expect(() => dependency(key, { git: input.git, branch: "main" }, {}, config, "0.1.14"))
      .toThrow("immutable upstream Git revision");
  }
});

test("all GPU dependencies use the same repository and revision across targets", () => {
  const source = { wgpu_repository: "https://github.com/gfx-rs/wgpu", wgpu_revision: revision };
  const exact = { git: source.wgpu_repository, rev: revision };
  verifyGpuDependencies({ target: { linux: { dependencies: { wgpu: exact } } } }, source);
  for (const [name, value] of [
    ["naga", { version: "30" }],
    ["wgpu-core", { ...exact, rev: "0".repeat(40) }],
    ["shader", { package: "naga", ...exact, git: "https://example.invalid/wgpu" }],
  ]) {
    expect(() => verifyGpuDependencies({ dependencies: { [name as string]: value } }, source))
      .toThrow("exact upstream wgpu source");
  }
});

test("Fast iOS dependency uses the generated Fast identity after Apple and before platform", () => {
  expect(config.crates.indexOf("gpui_ios")).toBeGreaterThan(config.crates.indexOf("gpui_apple"));
  expect(config.crates.indexOf("gpui_ios")).toBeLessThan(config.crates.indexOf("gpui_platform"));
  expect(dependency("gpui_ios", { path: "unused" }, {}, config, "0.1.14")).toEqual({
    package: "gpui-fast-ios", version: "^0.1.14", path: "../gpui_ios",
  });
});
