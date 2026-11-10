import { isAbsolute, relative, resolve } from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { ROOT, fastName, readToml, type ReleaseConfig } from "./release-common";
import { stringify } from "smol-toml";
import { pinnedPatches, validateCaptureRequirement } from "./release-dependencies";

export interface SourceProvenance {
  repository: string;
  source_commit: string;
  source_url: string;
  upstream_tag: string;
  upstream_commit: string;
  import_commit: string;
  zed_commit: string;
  snapshot_version: string;
  wgpu_repository: string;
  wgpu_revision: string;
  registry_patches: Record<string, any>;
  registry_patch_versions: Record<string, string>;
  source_ref: string;
  applies_registry_patches?: boolean;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  if (result.error) throw result.error;
  if (result.exitCode !== 0) {
    throw new Error("git " + args.join(" ") + ": " + result.stderr.toString("utf8").trim());
  }
  return result.stdout.toString("utf8");
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function dependencyDirectories(config: ReleaseConfig, root: string, workspace: any): string[] {
  const pending = config.crates.map(name => resolve(root, "crates", name));
  const distributed = new Set(pending);
  const visited = new Set<string>();
  while (pending.length) {
    const directory = pending.pop()!;
    const path = relative(root, directory).replaceAll("\\", "/");
    if (isAbsolute(path) || path === ".." || path.startsWith("../")) {
      throw new Error("Local dependency is outside the source repository: " + directory);
    }
    if (visited.has(path)) continue;
    visited.add(path);
    const manifest = readToml(resolve(directory, "Cargo.toml"));
    for (const group of [manifest, ...Object.values(manifest.target ?? {})] as any[]) {
      for (const section of ["dependencies", "build-dependencies"]) {
        for (const [key, input] of Object.entries(group[section] ?? {}) as [string, any][]) {
          if (typeof input === "string") continue;
          const inherited = input.workspace;
          const value = inherited ? workspace.dependencies[key] : input;
          if (value?.path) {
            const dependency = resolve(inherited ? root : directory, value.path);
            if (!distributed.has(directory) && distributed.has(dependency)) {
              throw new Error("Delegated snapshot helper depends on a distributed backend: "
                + path + " -> " + key);
            }
            pending.push(dependency);
          }
        }
      }
    }
  }
  return [...visited];
}

/** Refuse to attribute dirty files or silently replace patched support crates. */
export function inspectSource(config: ReleaseConfig, root = ROOT): SourceProvenance {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(config.upstream_tag)
      || !/^[0-9a-f]{40}$/.test(config.upstream_commit)
      || !/^[0-9a-f]{40}$/.test(config.source_commit)) {
    throw new Error("Configure an explicit upstream_tag and immutable upstream_commit/source_commit");
  }
  const head = git(root, "rev-parse", "--verify", "HEAD^{commit}").trim();
  const source = git(root, "rev-parse", "--verify", config.source_commit + "^{commit}").trim();
  git(root, "merge-base", "--is-ancestor", source, head);
  const base = git(root, "rev-parse", "--verify", "refs/tags/" + config.upstream_tag + "^{commit}").trim();
  if (base !== config.upstream_commit) {
    throw new Error("Upstream tag does not match its pinned commit");
  }
  git(root, "merge-base", "--is-ancestor", base, source);
  const baseline = Bun.TOML.parse(git(root, "show", base + ":release.toml")) as ReleaseConfig;
  if (baseline.snapshot_version !== config.snapshot_version) {
    throw new Error("Support snapshot differs from the pinned upstream release");
  }
  const manifest = readToml(resolve(root, "Cargo.toml"));
  const workspace = manifest.workspace;
  const lock = readToml(resolve(root, "Cargo.lock"));
  const { patches, versions } = pinnedPatches(manifest, lock);
  const wgpu = workspace.dependencies.wgpu;
  const baselineWgpu = Bun.TOML.parse(git(root, "show", base + ":Cargo.toml"))
    .workspace.dependencies.wgpu;
  if (!wgpu?.git || !/^[0-9a-f]{40}$/.test(wgpu.rev) || wgpu.branch || wgpu.tag
      || wgpu.git !== baselineWgpu.git || wgpu.rev !== baselineWgpu.rev) {
    throw new Error("wgpu must retain the pinned upstream release's exact Git dependency");
  }
  validateCaptureRequirement(config.windows_capture_requirement, versions["windows-capture"]);
  const upstream = readToml(resolve(root, "UPSTREAM"));
  const baselineUpstream = Bun.TOML.parse(git(root, "show", base + ":UPSTREAM"));
  if (upstream.import_commit !== baselineUpstream.import_commit
      || upstream.zed_commit !== baselineUpstream.zed_commit) {
    throw new Error("UPSTREAM differs from the pinned upstream release");
  }
  const distributed = config.crates.map(name => "crates/" + name);
  const directories = [...new Set([
    ...upstream.tracked, ...dependencyDirectories(config, root, workspace),
  ])] as string[];
  const omitted = directories.filter(path => !distributed.includes(path));
  const inputs = ["Cargo.toml", "Cargo.lock", "UPSTREAM", "LICENSE", "NOTICE", "rust-toolchain.toml",
    ...new Set([...distributed, ...directories])];
  const changedSinceSource = paths(git(root, "diff", "--name-only", "-z", source, head, "--", ...inputs));
  if (changedSinceSource.length) {
    throw new Error("HEAD source inputs differ from configured source_commit: " + changedSinceSource.join(", "));
  }
  const tree = paths(git(root, "ls-tree", "-r", "-z", source, "--", ...inputs));
  const symlinkTargets: string[] = [];
  for (const entry of tree) {
    if (!entry.startsWith("120000 ")) continue;
    const path = entry.slice(entry.indexOf("\t") + 1);
    const file = resolve(root, path);
    if (!lstatSync(file).isSymbolicLink()) {
      throw new Error("Source symlink is a checkout stub; enable Git core.symlinks: " + path);
    }
    const target = realpathSync(file);
    const targetPath = relative(root, target).replaceAll("\\", "/");
    if (isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith("../")
        || !statSync(target).isFile()) {
      throw new Error("Source symlinks must resolve to tracked files inside the checkout: " + path);
    }
    symlinkTargets.push(targetPath);
  }
  if (symlinkTargets.length) git(root, "ls-files", "--error-unmatch", "--", ...new Set(symlinkTargets));
  inputs.push(...symlinkTargets);
  const hidden = paths(git(root, "ls-files", "-v", "-z", "--", ...inputs))
    .filter(entry => entry[0] === "S" || entry[0] === entry[0].toLowerCase());
  if (hidden.length) {
    throw new Error("Source inputs use skip-worktree or assume-unchanged flags: "
      + hidden.map(entry => entry.slice(2)).join(", "));
  }
  const dirty = paths(git(root, "diff", "--name-only", "-z", "HEAD", "--", ...inputs));
  // Include ignored files: recursive copies would otherwise package them too.
  const untracked = paths(git(root, "ls-files", "--others", "-z", "--", ...inputs));
  if (dirty.length || untracked.length) {
    throw new Error("Source inputs must be committed before generation: "
      + [...dirty, ...untracked].join(", "));
  }
  const discarded = omitted.length
    ? paths(git(root, "diff", "--no-renames", "--name-only", "-z", base, source, "--", ...omitted))
    : [];
  if (discarded.length) {
    throw new Error("Fork changes outside generated crates would be omitted by registry snapshots: "
      + discarded.join(", "));
  }
  return {
    repository: config.repository,
    source_commit: source,
    source_url: config.repository.replace(/\/$/, "") + "/tree/" + source,
    upstream_tag: config.upstream_tag,
    upstream_commit: base,
    import_commit: upstream.import_commit,
    zed_commit: upstream.zed_commit,
    snapshot_version: config.snapshot_version,
    wgpu_repository: wgpu.git,
    wgpu_revision: wgpu.rev,
    registry_patches: patches,
    registry_patch_versions: versions,
    source_ref: config.source_ref,
  };
}

export function verifySourcePublication(source: SourceProvenance, root = ROOT): void {
  if (!/^refs\/(heads|tags)\/.+/.test(source.source_ref)) {
    throw new Error("Configure an explicit source branch or tag for publication verification");
  }
  const refs = git(root, "ls-remote", source.repository, source.source_ref, source.source_ref + "^{}")
    .trim().split(/\r?\n/).filter(Boolean).map(line => line.split("\t"));
  const commit = refs.find(entry => entry[1] === source.source_ref + "^{}")
    ?? refs.find(entry => entry[1] === source.source_ref);
  if (commit?.[0] !== source.source_commit) {
    throw new Error("Source publication is unverified: expected " + source.source_ref
      + " at " + source.source_commit);
  }
}

export function sourceChanges(config: ReleaseConfig, source: SourceProvenance, root = ROOT) {
  const distributed = config.crates.map(name => "crates/" + name);
  return [
    { revisions: [source.import_commit, source.upstream_commit], notice: "// Modified by Longbridge for gpui-fast." },
    { revisions: [source.upstream_commit, source.source_commit], notice: "// Modified by NtTestAlert for the GPUI Fast fork." },
  ].map(({ revisions, notice }) => ({
    notice, files: paths(git(root, "diff", "--no-renames", "--name-only", "-z", ...revisions, "--", ...distributed)),
  }));
}

export function forkReadme(name: string, config: ReleaseConfig, source: SourceProvenance): string {
  return "# " + fastName(name) + "\n\nGPUI with gpui-fast rendering and layout optimizations.\n\n"
    + "NtTestAlert GPUI Fast fork: [" + config.repository + "](" + config.repository + ").\n\n"
    + "Expected source location: [" + source.source_commit + "](" + source.source_url + ").\n\n"
    + "Generation does not verify remote publication. Before releasing this distribution, run "
    + "bun script/verify-source-publication.ts from its repository checkout.\n\n"
    + "Based on Longbridge GPUI Fast " + source.upstream_tag + " ("
    + source.upstream_commit + "), with Zed import " + source.import_commit + ".\n\n"
    + "The unpublished distribution preserves upstream wgpu Git revision "
    + source.wgpu_revision + ".\n\n"
    + "Forked from Zed's GPUI; distributed under Apache-2.0.\n\n"
    + "Replace DISTRIBUTION_COMMIT_SHA below with the published distribution's immutable commit; "
    + "the source revision above identifies reviewed source rather than the generated distribution.\n\n"
    + "Default consumers keep registry shared dependencies. These aliases do not require shared-crate patches.\n\n"
    + "One optional Windows capture dependency is bounded to " + config.windows_capture_requirement
    + " because Scap uses the older "
    + "Settings API. If the consuming root exposes capture, lock resolution can apply this bound even when "
    + "that feature is disabled, changing the shared capture lock entry for standard and Fast backends. "
    + "A plain Kit/Component root without capture exposure retained 1.5.0 in our separate probe. "
    + "The bound does not enable capture compilation by itself. Check the actual application's lock and target tree.\n\n"
    + "~~~toml\n" + stringify({
      dependencies: {
        gpui: { package: "gpui-fast", git: config.repository, rev: "DISTRIBUTION_COMMIT_SHA" },
        gpui_platform: { package: "gpui-fast-platform", git: config.repository,
          rev: "DISTRIBUTION_COMMIT_SHA", features: ["wayland", "x11"] },
      },
    }) + "~~~\n\n"
    + "Optional source-parity patches follow. Cargo applies them only from your application's workspace root; "
    + "dependency workspaces do not transmit them. They change shared dependencies for every backend in that "
    + "workspace, so compare lockfiles, target-specific trees and runtime behavior before adopting them. "
    + "Source-patch mode for this generated workspace: " + (source.applies_registry_patches ? "enabled" : "disabled") + ".\n\n"
    + "Without these optional patches, source-workspace fixes for Linux EGL error handling and idle/calloop, "
    + "async scheduling/process behavior, Web worker bootstrap, and Windows capture may be absent. "
    + "This is not evidence that every default consumer fails to build. Screen capture and Web worker linkage "
    + "require explicit feature/target checks; no compatibility or runtime pass is implied.\n\n"
    + "~~~toml\n" + stringify({ patch: source.registry_patches }) + "~~~\n";
}
