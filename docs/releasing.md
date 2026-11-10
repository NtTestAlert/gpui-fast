# Preparing the GPUI Fast Git distribution

This fork distributes generated packages through an immutable Git commit.
It does not publish them to crates.io. The upstream registry publication
workflow and script/publish-release.ts do not validate this fork's Git output:
the packages intentionally set publish = false and retain Git dependencies.

The generated package set contains ten crates: gpui-fast, gpui-fast-macros,
gpui-fast-apple, gpui-fast-ios, gpui-fast-wgpu, gpui-fast-macos, gpui-fast-linux,
gpui-fast-windows, gpui-fast-web and gpui-fast-platform. The iOS package must
remain in this set so the Fast platform returns the same GPUI types as its
iOS implementation. Inclusion does not establish iOS build or runtime support.

## Source and dependency provenance

release.toml pins an upstream tag and commit independently of the generated
package version and pins the reviewed source commit separately. Later
packaging-only commits may regenerate that same source; their guarded source
inputs must match the configured commit. Generation rejects dirty or untracked source inputs, hidden index
flags, symlink checkout stubs, and changes to support crates that would otherwise
be replaced by registry snapshots. Delegated helpers must not depend on
distributed backend types; this is why the iOS crate is included. Unmodified support packages remain pinned
to the exact gpui-pre snapshot.

Generated manifests and READMEs record the source commit, upstream base,
Zed import, support snapshot, wgpu revision and consumer workspace patches.
Source and distribution commits are distinct. Source links describe the
expected remote location; generation alone does not verify publication.
Before releasing the distribution, verify its source is fetchable:

~~~sh
bun script/verify-source-publication.ts
~~~

This read-only command checks the configured source branch or tag against the
generated source SHA. It must pass before publishing the distribution commit.

Every direct Git dependency retains its exact source revision. In particular,
wgpu keeps upstream's queue and texture APIs and its Vulkan surface-drop fix;
the generator does not adapt its Rust source to registry wgpu APIs. GPUI Kit
also brings standard renderer dependencies into Fast Linux and Web graphs, so
both the Fast Git and standard registry wgpu stacks can compile.

Default generation applies no shared-crate patch table and leaves existing
registry requirements unchanged except for the Windows capture compatibility
bound described below. It adds no calloop or async-task exact constraint.

The Fast core adds an optional windows-capture requirement >=1.3.6, <1.5,
activated only with screen-capture. Scap uses five Settings::new arguments;
windows-capture 1.5.0 requires eight. Lock resolution considers features exposed
by the consuming workspace root. In a root that exposed screen-capture but left
it disabled, a controlled comparison changed the shared capture lock entry from
1.5.0 to 1.4.4 and left every other package ID unchanged. A separate genuinely
plain Kit/Component root, without that feature or capture-specific aliases,
retained 1.5.0 despite using the same bounded Fast packages. The generated
workspace itself exposes the core crate's features and is a different root.

When this bound participates in resolution, standard and Fast capture paths
share the resulting lock entry. The default Windows target tree of the
capture-exposing probe did not include Scap or windows-capture, so this lock
effect did not activate capture compilation. These probes do not establish the
effect on Atrophy or another application's lock; check its actual root separately.

The generated metadata and READMEs separately offer optional source-parity
patches for async-process, async-task, windows-capture, calloop and khronos-egl.
Moving patches are pinned to the source lock revision. An optional wasm_thread
patch aligns the registry scheduler's worker implementation with Fast Web's
direct Git worker dependency. Use --source-patches only for an explicitly
separate comparison; these root patches affect every backend in that workspace.
They do not guarantee the resolver selects a patched candidate over a newer
registry version. Confirm the actual lockfile and tree.

Without those patches, Linux EGL error/idle handling, async scheduling/process
fixes, Web worker bootstrap and Windows capture behavior may differ from the
source workspace. This is not a demonstrated build failure for every default
consumer. The source lock selects windows-capture 1.4.3, while scap's registry
requirement alone would permit newer versions with a changed Settings API.
The bounded Fast dependency prevents selecting 1.5.0; check the resolved version
and compile screen-capture explicitly before advertising capture support.
Web compilation alone does not validate worker bootstrap.

Cargo does not inherit dependency-workspace patches. Optional patches belong
in the consuming workspace root only when the owner chooses them. The default
alias snippet requires no such shared-crate patches. Replace
DISTRIBUTION_COMMIT_SHA with the published distribution SHA, not the source SHA.
Kit consumers must override all ten gpui-fast packages to that same revision.

## Preparation and verification

Install the toolchain named by rust-toolchain.toml and the frozen generator
dependency. Run from this repository's root:

~~~sh
bun install --frozen-lockfile
bun test script/release.test.ts script/release-provenance.test.ts script/release-dependencies.test.ts
bun script/prepare-release.ts --tag v0.1.14
python script/check-upstream
~~~

Preparation replaces distribution/. A custom destination must be inside
target/. Generate a second copy there and compare every relative path and file
hash; record the source commit, generator diff and comparison result.
The generator uses Bun's TOML parser and the frozen smol-toml serializer.

Run standalone generated-workspace checks, rather than relying only on the
source workspace:

~~~sh
cargo check --manifest-path distribution/Cargo.toml --workspace --lib
cargo check --manifest-path distribution/Cargo.toml -p gpui-fast-wgpu --lib
~~~

Create two independent GPUI Kit/Component 0.9.1 consumers with separate
lockfiles. Both override the ten Fast packages; only the second opts into
shared source-parity patches:

~~~sh
bun script/prepare-consumer.ts --dest target/consumer-default
bun script/prepare-consumer.ts --dest target/consumer-source-patches --source-patches
bun script/prepare-consumer.ts --dest target/consumer-capture --capture
cargo check --manifest-path target/consumer-default/Cargo.toml --lib
cargo check --manifest-path target/consumer-source-patches/Cargo.toml --lib
cargo tree --manifest-path target/consumer-default/Cargo.toml --target x86_64-pc-windows-msvc > target/consumer-default/tree-windows.txt
cargo tree --manifest-path target/consumer-source-patches/Cargo.toml --target x86_64-pc-windows-msvc > target/consumer-source-patches/tree-windows.txt
~~~

Compare both Cargo.lock files and target-specific trees. Record exact source
identities for async-process, async-task, calloop, khronos-egl, windows-capture,
wasm_thread, the ten Fast packages, standard support and both GPU stacks.
Repeat tree/metadata comparisons for x86_64-unknown-linux-gnu,
aarch64-apple-darwin, aarch64-apple-ios and wasm32-unknown-unknown.
Graph resolution does not replace compilation or runtime checks on those hosts.

The default probes contain no root screen-capture feature. Compare their lock
resolution with the separate capture-exposing probe before enabling that feature.
On Windows run the capture probe explicitly:

~~~sh
cargo check --manifest-path target/consumer-capture/Cargo.toml --lib --features screen-capture
~~~

Prepare a separate --capture --source-patches probe when comparing optional
patch mode. Record the resolved requirement/version and actual compiler result.
For Web, check both modes with a suitable nightly toolchain and the wasm target,
inspect whether the scheduler and Fast dispatcher share a worker package
identity, and exercise worker startup in a browser before claiming it works.

Source shader tests retain their direct Naga dev-dependency and belong in
the source workspace. A Windows check of gpui-fast-wgpu verifies APIs but
does not exercise Linux Vulkan. Linux Vulkan device-loss/surface-destruction,
macOS Metal, iOS and Web compilation/runtime need suitable hosts or toolchains;
record unavailable checks explicitly.

The fork's workflow validates generated/default-consumer graphs on manual and
pull-request runs. It has no tag-triggered or crates.io publication job; optional
feature and runtime evidence still needs explicit recording.

After the reviewed distribution branch is published, dispatch its workflow
explicitly using that topic ref:

~~~sh
gh workflow run release.yml --repo NtTestAlert/gpui-fast --ref atrophy-dist-0.1.14
~~~

workflow_dispatch requires this workflow file to exist on the repository's
default branch. If that prerequisite is absent, open a topic-base PR from
atrophy-dist-0.1.14 into atrophy-gpui-fast-0.1.14 so the pull_request trigger
validates the proposed workflow without merging it into main. Record the actual
Actions run URL and conclusion; a local YAML parse is not an executed CI pass.

Review source changes and generated artifacts before committing or publishing
the corresponding fork branches. Do not treat a successful source build,
synthetic generator fixture, or Windows DirectX run as a substitute for these
standalone and platform-specific checks.
