import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify } from "smol-toml";
import { ROOT, readConfig, readToml } from "./release-common";
import { prepare } from "./prepare-release";
import { prepareConsumer } from "./prepare-consumer";
import { forkReadme, inspectSource, sourceChanges, verifySourcePublication } from "./release-provenance";

function withSource(check: (fixture: ReturnType<typeof sourceFixture>) => void): void {
  const fixture = sourceFixture();
  try {
    check(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function sourceFixture() {
  const scratch = resolve(ROOT, "target");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "provenance-test-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const write = (path: string, content: string) => {
    const file = resolve(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  let config: ReturnType<typeof readConfig> | undefined;
  const commit = (stage = true) => {
    if (stage) git("add", ".");
    git("-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture");
    const sha = git("rev-parse", "HEAD");
    if (config) config.source_commit = sha;
    return sha;
  };
  git("init", "--quiet");
  git("config", "core.fsmonitor", "false");
  write(".gitignore", "ignored.rs\n");
  write("Cargo.lock", stringify({ package: [
    { name: "calloop", version: "0.14.3", source: "git+https://example.invalid/calloop#" + "a".repeat(40) },
    { name: "windows-capture", version: "1.4.3", source: "git+https://example.invalid/capture#" + "b".repeat(40) },
  ] }));
  write("Cargo.toml", stringify({ patch: { "crates-io": {
    calloop: { git: "https://example.invalid/calloop" },
    "windows-capture": { git: "https://example.invalid/capture", rev: "b".repeat(40) },
  } }, workspace: {
    package: { edition: "2024" }, lints: { rust: {} }, dependencies: {
    helper: { path: "crates/helper" },
    wgpu: { git: "https://github.com/gfx-rs/wgpu", rev: "cddb2f5d80dc0009b2ef6767635140cacf90a007" },
  } } }));
  write("crates/gpui/Cargo.toml", stringify({
    package: { name: "gpui", version: "0.2.2" }, lib: { path: "src/lib.rs" },
    features: { "screen-capture": [] }, dependencies: { helper: { workspace: true } },
  }));
  for (const name of ["gpui_apple", "gpui_wgpu"]) {
    write("crates/" + name + "/Cargo.toml", stringify({
      package: { name, version: "0.2.2" }, lib: { path: "src/lib.rs" },
      dependencies: name === "gpui_wgpu" ? { wgpu: { workspace: true } } : {},
    }));
    write("crates/" + name + "/src/lib.rs", "// fixture\n");
  }
  write("crates/gpui_apple/build.rs", 'fn main() { let _ = std::path::Path::new(".").join("../gpui"); }\n');
  write("crates/gpui_wgpu/src/upstream_api.rs", "wgpu::DeviceDescriptor { default_queue: wgpu::QueueDescriptor::default() }\nformat.has_srgb_suffix()\n");
  for (const file of ["scene.rs", "geometry.rs", "color.rs", "window.rs", "platform.rs", "window/test.rs", "platform/test.rs"]) {
    write("crates/gpui/src/" + file, "// imported fixture\n");
  }
  write("LICENSE", "Apache-2.0 fixture\n");
  write("rust-toolchain.toml", '[toolchain]\nchannel = "stable"\n');
  write("crates/helper/Cargo.toml", stringify({
    package: { name: "helper", version: "0.1.0" }, dependencies: { nested: { path: "../nested" } },
  }));
  write("crates/nested/Cargo.toml", stringify({ package: { name: "nested", version: "0.1.0" } }));
  write("crates/gpui/src/lib.rs", "pub fn imported() {}\n");
  write("crates/helper/src/lib.rs", "pub fn helper() {}\n");
  write("crates/nested/src/lib.rs", "pub fn nested() {}\n");
  const imported = commit();
  write("UPSTREAM", stringify({
    import_commit: imported, zed_commit: "1".repeat(40),
    tracked: ["crates/gpui", "crates/helper"],
  }));
  write("release.toml", stringify({ snapshot_version: "0.3.12" }));
  write("crates/gpui/src/lib.rs", "pub fn upstream_fast() {}\n");
  const base = commit();
  git("tag", "v0.1.14");
  config = { ...readConfig(), crates: ["gpui", "gpui_apple", "gpui_wgpu"], upstream_commit: base, source_commit: base };
  return { root, config: config!, git, write, commit, base, imported };
}

test("source provenance names the fork, immutable source, upstream base and wgpu", () => {
  withSource(({ root, config, base, imported }) => {
    const source = inspectSource(config, root);
    expect(source.source_commit).toBe(base);
    expect(source.upstream_commit).toBe(base);
    expect(source.import_commit).toBe(imported);
    expect(source.wgpu_revision).toBe("cddb2f5d80dc0009b2ef6767635140cacf90a007");
    const readme = forkReadme("gpui", config, source);
    expect(readme).toContain("NtTestAlert GPUI Fast fork");
    expect(readme).toContain(config.repository + "/tree/" + base);
    expect(readme).toContain("rather than the generated distribution");
    expect(readme).toContain('package = "gpui-fast"');
    expect(readme).toContain('rev = "DISTRIBUTION_COMMIT_SHA"');
    expect(readme).toContain("Generation does not verify remote publication");
  });
}, 60000);

test("change notices use pinned base and include committed additions", () => {
  withSource(({ root, config, write, commit, base }) => {
    write("crates/gpui/src/new.rs", "pub fn fork_added() {}\n");
    const fork = commit();
    const source = inspectSource(config, root);
    const changes = sourceChanges(config, source, root);
    expect(source.source_commit).toBe(fork);
    expect(source.upstream_commit).toBe(base);
    expect(changes[0].files).toContain("crates/gpui/src/lib.rs");
    expect(changes[0].files).not.toContain("crates/gpui/src/new.rs");
    expect(changes[1].files).toEqual(["crates/gpui/src/new.rs"]);
    expect(changes[1].notice).toContain("NtTestAlert");
  });
}, 60000);

test("generation rejects unstaged and staged source changes", () => {
  withSource(({ root, config, write, git }) => {
    write("crates/gpui/src/lib.rs", "pub fn dirty() {}\n");
    expect(() => inspectSource(config, root)).toThrow("Source inputs must be committed");
    git("add", "crates/gpui/src/lib.rs");
    expect(() => inspectSource(config, root)).toThrow("Source inputs must be committed");
  });
}, 60000);

test("generation rejects untracked and ignored files that recursive copying would include", () => {
  withSource(({ root, config, write }) => {
    write("crates/gpui/src/new.rs", "pub fn untracked() {}\n");
    expect(() => inspectSource(config, root)).toThrow("crates/gpui/src/new.rs");
  });
  withSource(({ root, config, write }) => {
    write("crates/gpui/src/ignored.rs", "pub fn ignored() {}\n");
    expect(() => inspectSource(config, root)).toThrow("crates/gpui/src/ignored.rs");
  });
}, 60000);

test("generation rejects committed support changes, including transitive unlisted crates", () => {
  for (const path of ["crates/helper/src/lib.rs", "crates/nested/src/lib.rs"]) {
    withSource(({ root, config, write, commit }) => {
      write(path, "pub fn modified_support() {}\n");
      commit();
      let message = "";
      try { inspectSource(config, root); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("outside generated crates would be omitted");
      expect(message).toContain(path);
    });
  }
}, 60000);

test("generation rejects moved tags, mismatched snapshots and changed wgpu source", () => {
  withSource(({ root, config }) => {
    expect(() => inspectSource({ ...config, upstream_commit: "0".repeat(40) }, root))
      .toThrow("tag does not match");
    expect(() => inspectSource({ ...config, snapshot_version: "0.3.10" }, root))
      .toThrow("Support snapshot differs");
  });
  withSource(({ root, config, write, commit }) => {
    write("Cargo.toml", stringify({ workspace: { dependencies: {
      wgpu: { git: "https://github.com/gfx-rs/wgpu", rev: "2".repeat(40) },
    } } }));
    commit();
    expect(() => inspectSource(config, root)).toThrow("exact Git dependency");
  });
}, 60000);

test("generation records immutable provenance and notices even with a different output version", () => {
  withSource(({ root, config, write, commit, base }) => {
    write("crates/gpui/src/new.rs", "pub fn fork_added() {}\n");
    write("crates/gpui/src/geometry.rs", "// fork geometry fixture\n");
    const source = commit();
    const dest = resolve(root, "distribution");
    prepare(config, "0.1.99", dest, root);
    const core = readToml(resolve(dest, "gpui/Cargo.toml"));
    expect(core.package.version).toBe("0.1.99");
    expect(core.package.publish).toBe(false);
    expect(core.package.metadata["gpui-fast-fork"].source_commit).toBe(source);
    expect(core.package.metadata["gpui-fast-fork"].upstream_commit).toBe(base);
    expect(core.package.metadata["gpui-fast-fork"].upstream_tag).toBe("v0.1.14");
    expect(readToml(resolve(dest, "Cargo.toml")).patch).toBeUndefined();
    expect(core.features["screen-capture"]).toEqual(["dep:windows-capture"]);
    expect(core.target['cfg(target_os = "windows")'].dependencies["windows-capture"]).toEqual({
      version: ">=1.3.6, <1.5.0", optional: true,
    });
    expect(readFileSync(resolve(dest, "gpui/README.md"), "utf8")).toContain("/tree/" + source);
    expect(forkReadme("gpui", { ...config, windows_capture_requirement: ">=1.4.3, <1.5.0" },
      core.package.metadata["gpui-fast-fork"])).toContain("bounded to >=1.4.3, <1.5.0");
    expect(readFileSync(resolve(dest, "gpui/README.md"), "utf8")).toContain('rev = "' + "a".repeat(40) + '"');
    expect(readFileSync(resolve(dest, "gpui/src/new.rs"), "utf8")).toStartWith("// Modified by NtTestAlert");
    expect(readFileSync(resolve(dest, "gpui_apple/src/fast/release_gpui/src/geometry.rs"), "utf8"))
      .toStartWith("// Modified by NtTestAlert");
    const wgpu = readToml(resolve(dest, "gpui_wgpu/Cargo.toml")).dependencies.wgpu;
    expect(wgpu.git).toBe("https://github.com/gfx-rs/wgpu");
    expect(wgpu.rev).toBe("cddb2f5d80dc0009b2ef6767635140cacf90a007");
    expect(wgpu.version).toBeUndefined();
    expect(readFileSync(resolve(dest, "gpui_wgpu/src/upstream_api.rs"), "utf8"))
      .toBe(readFileSync(resolve(root, "crates/gpui_wgpu/src/upstream_api.rs"), "utf8"));
    const patched = resolve(root, "target/source-patches");
    prepare(config, "0.1.99", patched, root, true);
    expect(readToml(resolve(patched, "Cargo.toml")).patch["crates-io"].calloop.rev).toBe("a".repeat(40));
    expect(readToml(resolve(patched, "Cargo.toml")).workspace.metadata["gpui-fast-fork"].applies_registry_patches).toBe(true);
    const defaultConsumer = resolve(root, "target/consumer-default");
    const patchedConsumer = resolve(root, "target/consumer-source-patches");
    prepareConsumer(defaultConsumer, dest, false, root);
    prepareConsumer(patchedConsumer, dest, true, root);
    const captureConsumer = resolve(root, "target/consumer-capture");
    prepareConsumer(captureConsumer, dest, false, root, true);
    expect(readToml(resolve(defaultConsumer, "Cargo.toml")).features).toBeUndefined();
    expect(readToml(resolve(defaultConsumer, "Cargo.toml")).dependencies.gpui_fast_core).toBeUndefined();
    expect(readToml(resolve(captureConsumer, "Cargo.toml")).features["screen-capture"])
      .toEqual(["gpui_fast_core/screen-capture", "gpui_platform/screen-capture"]);
    expect(readToml(resolve(captureConsumer, "Cargo.toml")).dependencies.gpui_fast_core["default-features"]).toBe(false);
    expect(readToml(resolve(captureConsumer, "Cargo.toml")).dependencies.gpui_platform["default-features"]).toBe(false);
    expect(readToml(resolve(defaultConsumer, "Cargo.toml")).patch["crates-io"].calloop).toBeUndefined();
    expect(readToml(resolve(patchedConsumer, "Cargo.toml")).patch["crates-io"].calloop.rev).toBe("a".repeat(40));
    expect(readToml(resolve(defaultConsumer, "Cargo.toml")).patch["crates-io"]["gpui-fast"].path)
      .toBe(resolve(dest, "gpui"));
    write("distribution/sentinel", "preserve existing output");
    write("crates/gpui/src/ignored.rs", "pub fn dirty_ignored() {}\n");
    expect(() => prepare(config, "0.1.99", dest, root)).toThrow("Source inputs must be committed");
    expect(readFileSync(resolve(dest, "sentinel"), "utf8")).toBe("preserve existing output");
    expect(() => prepare(config, "0.1.99", resolve(root, "crates/gpui"), root))
      .toThrow("Distribution output must be");
  });
}, 60000);

test("source inspection rejects missing, source-excluding and 1.5-admitting capture requirements", () => {
  withSource(({ root, config }) => {
    for (const [requirement, message] of [
      [undefined, "must be configured"], ["<1.4.0", "must admit"], [">=1.3.6", "must reject"], ["1.4", "explicit comparators"],
    ] as const) {
      expect(() => inspectSource({ ...config, windows_capture_requirement: requirement as any }, root))
        .toThrow(message);
    }
  });
}, 60000);

test("configured source provenance remains stable after a packaging-only commit", () => {
  withSource(({ root, config, write, commit, base }) => {
    write("packaging.txt", "generator-only fixture change\n");
    commit();
    config.source_commit = base;
    expect(inspectSource(config, root).source_commit).toBe(base);
    write("crates/gpui/src/lib.rs", "pub fn source_changed() {}\n");
    commit();
    config.source_commit = base;
    expect(() => inspectSource(config, root)).toThrow("HEAD source inputs differ");
  });
}, 60000);

test("delegated snapshot helpers cannot depend on the generated backend identity", () => {
  withSource(({ root, config, write, commit }) => {
    write("crates/helper/Cargo.toml", stringify({
      package: { name: "helper", version: "0.1.0" }, dependencies: { gpui: { path: "../gpui" } },
    }));
    commit();
    expect(() => inspectSource(config, root)).toThrow("Delegated snapshot helper depends on a distributed backend");
  });
}, 60000);

test("generation rejects index flags that could hide source modifications", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    withSource(({ root, config, git, write }) => {
      git("update-index", flag, "crates/gpui/src/lib.rs");
      write("crates/gpui/src/lib.rs", "pub fn hidden_change() {}\n");
      expect(() => inspectSource(config, root)).toThrow("skip-worktree or assume-unchanged");
    });
  }
}, 60000);

test("generation refuses regular-file symlink stubs while accepting tracked real symlinks", () => {
  withSource(({ root, config, git, write, commit }) => {
    write("crates/gpui/LICENSE-APACHE", "../../LICENSE");
    const blob = git("hash-object", "-w", "crates/gpui/LICENSE-APACHE");
    git("update-index", "--add", "--cacheinfo", "120000," + blob + ",crates/gpui/LICENSE-APACHE");
    commit(false);
    expect(() => inspectSource(config, root)).toThrow("checkout stub");
  });
  withSource(({ root, config, commit }) => {
    symlinkSync("../../LICENSE", resolve(root, "crates/gpui/LICENSE-APACHE"));
    commit();
    expect(inspectSource(config, root).source_commit).toHaveLength(40);
  });
}, 60000);

test("source publication is an explicit read-only check against the advertised commit", () => {
  withSource(({ root, config, git }) => {
    const source = inspectSource(config, root);
    const advertised = { ...source, repository: root, source_ref: "refs/heads/published-fixture" };
    expect(source).not.toHaveProperty("source_publication");
    expect(() => verifySourcePublication(advertised, root)).toThrow("publication is unverified");
    git("update-ref", advertised.source_ref, source.source_commit);
    verifySourcePublication(advertised, root);
    expect(() => verifySourcePublication({ ...advertised, source_commit: "0".repeat(40) }, root))
      .toThrow("publication is unverified");
  });
}, 60000);
