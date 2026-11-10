import type { Manifest } from "./release-common";

export function validateCaptureRequirement(requirement: unknown, lockedVersion: string | undefined): void {
  if (typeof requirement !== "string" || !requirement.trim()) {
    throw new Error("windows_capture_requirement must be configured");
  }
  const comparators = requirement.split(",").map(value => value.trim());
  if (comparators.some(value => !/^(?:>=|<=|>|<|=)\s*\d+\.\d+\.\d+$/.test(value))) {
    throw new Error("windows_capture_requirement must use comma-separated explicit comparators with full versions");
  }
  const range = comparators.join(" ");
  if (!lockedVersion || !Bun.semver.satisfies(lockedVersion, range)) {
    throw new Error("windows_capture_requirement must admit the source locked windows-capture version");
  }
  if (Bun.semver.satisfies("1.5.0", range)) {
    throw new Error("windows_capture_requirement must reject the incompatible 1.5.0 API");
  }
}

function gitIdentity(source: string): string {
  return source.replace(/^git\+/, "").split(/[?#]/)[0].replace(/\/$/, "").replace(/\.git$/, "");
}

/** Carry workspace patches to consumers, pinning moving patches to the source lock. */
export function pinnedPatches(manifest: Manifest, lock: Manifest) {
  const patches = structuredClone(manifest.patch ?? {});
  const wasm = manifest.workspace?.dependencies?.wasm_thread;
  if (wasm?.git) {
    patches["crates-io"] ??= {};
    patches["crates-io"].wasm_thread = { git: wasm.git, rev: wasm.rev };
  }
  const versions: Record<string, string> = {};
  for (const entries of Object.values(patches) as Manifest[]) {
    for (const [key, patch] of Object.entries(entries) as [string, any][]) {
      if (!patch.git) throw new Error("Distribution patches must use external Git sources: " + key);
      const candidates = (lock.package ?? []).filter((pkg: any) =>
        pkg.name === (patch.package ?? key) && pkg.source?.startsWith("git+")
        && gitIdentity(pkg.source) === gitIdentity(patch.git));
      if (candidates.length !== 1) throw new Error("Missing or ambiguous source lock entry for patch: " + key);
      const locked = candidates[0];
      const revision = locked.source.split("#")[1];
      if (!/^[0-9a-f]{40}$/.test(revision) || (patch.rev && patch.rev !== revision)) {
        throw new Error("Source patch revision differs from its lock entry: " + key);
      }
      patch.rev = revision;
      delete patch.branch;
      delete patch.tag;
      versions[patch.package ?? key] = locked.version;
    }
  }
  return { patches, versions };
}

export function verifyGpuDependencies(manifest: Manifest, source: { wgpu_repository: string; wgpu_revision: string }): void {
  for (const group of [manifest, ...Object.values(manifest.target ?? {})] as Manifest[]) {
    for (const section of ["dependencies", "build-dependencies"]) {
      for (const [key, value] of Object.entries(group[section] ?? {}) as [string, any][]) {
        const name = value.package ?? key;
        if (!/^(wgpu|naga)(-|$)/.test(name)) continue;
        if (value.git !== source.wgpu_repository || value.rev !== source.wgpu_revision) {
          throw new Error("GPU dependency must retain the exact upstream wgpu source: " + name);
        }
      }
    }
  }
}
