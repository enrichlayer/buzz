# el-buzz identity and theme

The Enrich Layer fork is named **el-buzz**. The brand keeps the upstream bee
silhouette, drawn in sage with dotted construction guides and restrained pink
registration points. The generated concept is in
`desktop/public/branding/el-buzz/logo-concept.png`.

## Theme plugins

Buzz's existing theme engine now accepts declarative v2 theme plugins through
Settings → Plugins. Existing v1 content-renderer plugins keep their format and
behavior. The bundled `desktop/public/plugins/el-buzz.json` is the installable
Enrich Layer theme; choose **Load el-buzz theme**, review/install it, then select
**el-buzz** under Appearance → Dark → Theme style.

Theme plugins use the existing atomic installation store and support update,
enable/disable, removal and persistence across restarts. Each contribution has
a namespaced selection (`plugin:enrichlayer.el-buzz:dark`), a mode, a bundled
syntax base and semantic colors. Only allowlisted opaque `#RRGGBB` colors are
accepted; arbitrary CSS, JavaScript, URLs and remote syntax bundles are rejected.
Manifests are bounded to 64 KiB and eight themes, with unique local theme IDs.

A disabled, removed or unavailable selected theme displays Buzz Dark while
preserving the desired preference. Appearance explains the fallback; reinstall
or re-enable restores the selection. Explicitly choosing another theme replaces
it. Synced preferences remain valid on devices that lack the plugin. Updates
rebuild the variable snapshot from the base, so removed overrides cannot linger.
Async application is fenced by both generation and plugin-store snapshot.

The el-buzz package is dark-only, generated from the canonical Enrich Layer
foundation/semantic tokens. GitHub Dark remains its syntax and terminal base.
Existing conversation typography and keyboard zoom remain intact. The previous
local built-in `el-buzz` preference migrates to the plugin selection.

The dedicated native build command and app isolation are documented below.
The original logo lockup and derived native app icon are both included.

## Design-system ownership and packaging

The canonical reusable components live in `el-lander/packages/ui/Buzz`, exported
as `@el/ui/Buzz`, with Dark/Light/System preview and plugin-identity gallery states.
`ThemePreviewFrame`, `SystemPreferencePreviewFrame` and `PluginIdentity` render
props only. Buzz owns state, selection controls, accessibility labels, routing,
protocol and persistence; the library has no Tauri or Nostr dependency.

`@el/buzz-ui` packages the same source as a React-only distribution, avoiding the
Next.js peers of the full UI package. Buzz consumes a checked-in tarball under
`vendor/`; its package lock pins the archive integrity. Tailwind scans the package.
No private registry login or sibling source checkout is required to install Buzz.

In the design-system checkout:

```sh
node scripts/export-buzz-theme.mjs
node scripts/export-buzz-theme.mjs --check
node scripts/build-package-dist.mjs packages/buzz-ui
pnpm --dir packages/buzz-ui/dist pack --pack-destination ../../../.tmp/buzz-package
```

Copy `packages/buzz-ui/themes/el-buzz.json` into Buzz's `desktop/public/plugins/`.
Copy the packed archive into Buzz's `vendor/` using a new content-hash filename,
then update the desktop file dependency with `pnpm add --ignore-scripts`.
See `vendor/README.md` for the current source and archive receipt. Generated
packages retain the Apache license and upstream preview attribution.

The design-system source is in the isolated `codex/DEV-11398-el-buzz-theme-library` branch.
The theme generator consumes actual token values, including page900 = #282828
and the strong success/danger text colors, rather than older prose examples.

## Validation and defect ledger

Verified locally on the implementation:

- 43 plugin/schema/store, theme, terminal-palette and community-sync tests passed.
- Five DOM tests passed through the production theme provider and content renderer.
- Focused strict TypeScript check passed for all modified plugin/theme/Settings
  entry points and their transitive dependencies, with repository ambient types.
- Repaired E2E frontend build passed with the packaged `@el/buzz-ui` dependency.
- All four focused browser scenarios passed: install, keyboard select, restart,
  update, removed-token reset, disable/re-enable, removal fallback, invalid-theme
  rejection, missing-theme recovery and v1 content-plugin compatibility.
- Appearance and conversation screenshots in `.tmp/el-buzz-evidence/`
  were visually inspected.
- Portable package TypeScript check, package build, source formatting and
  frozen offline workspace lockfile check passed. Generated manifest matches
  canonical tokens and Buzz's copy byte-for-byte. Installed component code
  matches the integrity-pinned archive; LICENSE and NOTICE are included.
- Gallery registry generation and focused Buzz lint/diff checks passed.

| Finding | Disposition | Owner / next action | Evidence / validation |
| --- | --- | --- | --- |
| Missing/disabled plugin could invalidate a saved or synced theme | Fixed with retained selection and visible Buzz Dark fallback | This change; no further action | Provider and browser disable/re-enable/restart/removal tests |
| Updating a theme could leave removed colors behind | Fixed by deriving a fresh complete base before overlaying | This change; no further action | Store/provider tests and browser optional-token removal |
| An older async load could reapply a disabled or updated definition | Fixed with generation and store-snapshot fences | This change; no further action | Production-provider rapid update/disable regression |
| Shared preview depended on Buzz-local imports and HSL ambient tokens | Fixed with props-only library and explicit preview surfaces | This change; no further action | Portable TypeScript/build and browser screenshots |
| Repacking the same file dependency could retain old component bytes | Fixed with content-hash archive name and integrity-pinned lock entry | This change; no further action | Installed-source/archive byte comparison |
| Offline library lock generation lacked registry metadata | Resolved using existing pinned React resolutions and a minimal importer | This change; no further action | pnpm 10.24.0 frozen offline lockfile verification passed |
| Color-mode handler retained an old static-catalog reference | Fixed to use plugin-aware light/dark lookup; browser tests now fail on uncaught page errors | This change; no further action | Repaired build passed and both theme browser scenarios passed with no uncaught errors |
| Built-in syntax aliases retained the newly widened theme type | Narrowed alias constants to BuiltinThemeName | This change; no further action | Focused strict TypeScript check passed |
| Existing rejection test assumed every v2 manifest was unsupported | Updated fixture to unsupported v3 and the new version error | This change; no further action | Schema tests and corrected browser rejection scenario passed |
| Browser flows exceeded the default 30-second budget under host load | Resolved with bounded larger workflow budgets under host load | This change; no further action | All three unfinished flows passed in the bounded rerun |
| Temporary focused typecheck omitted existing ambient declarations | Added repository declaration files to the temporary checker config | This change; no further action | Final check exited successfully with no diagnostics |
| Focused lint initially ran against nested root configurations | Corrected invocation to desktop working directory | This change; no further action | Final 16-file check passed without configuration changes |

The desktop-wide TypeScript check was stopped after more than 25 minutes with
host load above 400. The focused strict check of modified plugin, theme and Settings entry points
and their transitive dependencies passed. Full `just ci`, native packaging and human testing
have not run. No PR, native release or shared package publication is claimed.

Human check: Settings → Plugins → Load el-buzz theme → Install, then
Appearance → Dark → Theme style → el-buzz. Inspect a conversation and restart.
Disable the package and expect Buzz Dark plus the recovery notice; re-enable
and expect el-buzz to return. Choose a different built-in theme to replace the
saved selection explicitly.


## Native el-buzz test distribution

Build from this branch with `cd desktop && pnpm tauri:el-buzz --debug --bundles app`.
The wrapper builds production frontend assets with `VITE_EL_BUZZ=1`; it validates
and installs the bundled manifest into a fresh plugin store before rendering.
The default is el-buzz dark. A saved empty store represents uninstall and is
never reseeded. Failed writes remain visible in Settings and retry next launch.

The overlay uses app identifier `com.enrichlayer.el-buzz` and the generated
native bee icon. The build command uses the existing isolated-demo identity
`el-buzz`, including `buzz-demo-el-buzz://` links and separate keyring/agent
configuration. This local test distribution has no updater endpoint.
Existing Buzz accounts are not copied into the new profile.

Native build inputs: the six sidecars are copied from the installed Buzz.app
(2026-10-13 build), not the empty placeholders in the original checkout. They
are local build inputs, not committed binaries. Reproducible source builds
should build the standard sidecars using the repository's native build recipes.

### Delivery validation (current fork main)

The delivery checkout starts at fork main `047ff3a2`, retaining the newer
segmented plugin controls. Focused validation on this tree passed 46 unit tests
and seven DOM tests, including the fresh-profile distribution default.
Native build, full desktop check, publication hooks and human testing are
pending while this local build runs; no native success is implied by those tests.

| Finding | Disposition | Owner / next action | Evidence / validation |
| --- | --- | --- | --- |
| Original native cache volume was unmounted and six sidecars were empty | Build in an isolated checkout using verified nonempty installed sidecars | Current author completes native build and launch | Installed app binaries copied; native build running |
| Frozen offline install lacked a cached package | Resolved by normal frozen online installation | This change; no further action | pnpm 11.4.0 installed all 728 packages |
| New distribution could reinstall a deliberately removed theme | Fixed by seeding only an absent plugin snapshot, never a saved empty store | This change; no further action | Bootstrap disable/uninstall/write-retry regression passed |
| New profile followed the OS and replaced the distribution theme | Fixed with a plugin-aware initial mode; stored user choices retain precedence | This change; no further action | Fresh-profile provider test passes with light OS preference |
| Library worktree hook dispatchers were absent | Restored Husky dispatchers and repeated the unpushed commit with hooks enabled | Current author verifies commit receipt | Library native hooks passed; commit `888cc1009` |
| Library spelling hook rejected a protocol name in prose | Reworded the component README | This change; no further action | Spelling hook passed on retry |

The desktop commit hook detected a duplicate animation-helper import after
applying the theme patch to current main. This was removed while retaining the
upstream helper call; the desktop hook is rerun before publication (owner:
current author, validation pending).
