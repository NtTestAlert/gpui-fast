# gpui-fast-web

GPUI with gpui-fast rendering and layout optimizations.

NtTestAlert GPUI Fast fork: [https://github.com/NtTestAlert/gpui-fast](https://github.com/NtTestAlert/gpui-fast).

Expected source location: [056ef5dd4da8d55607eab9205bf463262d8305b6](https://github.com/NtTestAlert/gpui-fast/tree/056ef5dd4da8d55607eab9205bf463262d8305b6).

Generation does not verify remote publication. Before releasing this distribution, run bun script/verify-source-publication.ts from its repository checkout.

Based on Longbridge GPUI Fast v0.1.14 (a427a7d9a6072473ad092b1673cd5235f99284cc), with Zed import bdae789de2ab285c7ae020506a6b62b0d0022367.

The unpublished distribution preserves upstream wgpu Git revision cddb2f5d80dc0009b2ef6767635140cacf90a007.

Forked from Zed's GPUI; distributed under Apache-2.0.

Replace DISTRIBUTION_COMMIT_SHA below with the published distribution's immutable commit; the source revision above identifies reviewed source rather than the generated distribution.

Default consumers keep registry shared dependencies. These aliases do not require shared-crate patches.

One optional Windows capture dependency is bounded to >=1.3.6, <1.5.0 because Scap uses the older Settings API. If the consuming root exposes capture, lock resolution can apply this bound even when that feature is disabled, changing the shared capture lock entry for standard and Fast backends. A plain Kit/Component root without capture exposure retained 1.5.0 in our separate probe. The bound does not enable capture compilation by itself. Check the actual application's lock and target tree.

~~~toml
[dependencies.gpui]
package = "gpui-fast"
git = "https://github.com/NtTestAlert/gpui-fast"
rev = "DISTRIBUTION_COMMIT_SHA"

[dependencies.gpui_platform]
package = "gpui-fast-platform"
git = "https://github.com/NtTestAlert/gpui-fast"
rev = "DISTRIBUTION_COMMIT_SHA"
features = [ "wayland", "x11" ]
~~~

Optional source-parity patches follow. Cargo applies them only from your application's workspace root; dependency workspaces do not transmit them. They change shared dependencies for every backend in that workspace, so compare lockfiles, target-specific trees and runtime behavior before adopting them. Source-patch mode for this generated workspace: disabled.

Without these optional patches, source-workspace fixes for Linux EGL error handling and idle/calloop, async scheduling/process behavior, Web worker bootstrap, and Windows capture may be absent. This is not evidence that every default consumer fails to build. Screen capture and Web worker linkage require explicit feature/target checks; no compatibility or runtime pass is implied.

~~~toml
[patch.crates-io.async-process]
git = "https://github.com/zed-industries/async-process.git"
rev = "0b6d6713570af61806e1e5cb40e0f757cb93fd9d"

[patch.crates-io.async-task]
git = "https://github.com/zed-industries/async-task.git"
rev = "015845a19fc31752c02367567d3b8900a406f9da"

[patch.crates-io.windows-capture]
git = "https://github.com/zed-industries/windows-capture.git"
rev = "f0d6c1b6691db75461b732f6d5ff56eed002eeb9"

[patch.crates-io.calloop]
git = "https://github.com/zed-industries/calloop"
rev = "eb6b4fd17b9af5ecc226546bdd04185391b3e265"

[patch.crates-io.khronos-egl]
git = "https://github.com/zed-industries/khronos-egl"
rev = "42214b36347b108fd9630ca6254b96dde59e04fe"

[patch.crates-io.wasm_thread]
git = "https://github.com/zed-industries/wasm_thread"
rev = "0cf96c7708dfb97ccf3da50347e25edcf75d6937"
~~~
