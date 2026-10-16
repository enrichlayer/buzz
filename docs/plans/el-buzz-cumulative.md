# One cumulative el-buzz desktop

Deliver one native application containing the fork's custom features. Keep the
existing production fork account: `com.enrichlayer.buzz`, release Keychain
service `buzz-desktop`, `.buzz` agents and `buzz://` links. A new display name or
icon does not require a new identity. Never export or combine identity keys.

## Source manifest

| Surface | Integrated source |
| --- | --- |
| Fork baseline and runtime/session plugins | `047ff3a2bcdcb19e3539e083f9a145d9114ee47a` |
| Native review and connected Linear work | `c322328657ce6fe51a6f2357ee41cd7f20a8d746` (PR42, includes PR28) |
| Floating annotations and source navigation | `6a1258b9ca1edc40dc6f01bdc5b28c18f56fc76a` |
| Prompt suggestions, author and recipient guards | `c217d2b7618c12e52993254b449ec629075c2bd0` |
| Logo, icons and runtime theme package | `d1ab0a32ffdc410a2ae857ffc17f880cc1534435`, with the author's profile-preserving correction |
| Internal icons and loading animations | `5aae9355cb7b4c828135e4c470e80d6fae057d7e`, using the verified `@el/buzz-ui` 0.2.0 archive from canonical library commit `04ef10f16f83c9bf30a0158ec4e6caccb1974ceb` |
| Code highlighting | Scoped existing changes from the original annotations checkout, including code/diff renderers and regression tests |
| Stable local signing and canonical installer | This cumulative branch; see [local signing](../local-macos-signing.md) |

The integration retains both thread-panel imports and both capture/branding
package scripts. Native sidecars must be built from this complete source. An
old executable with newer frontend files is not a cumulative native build.

## Build and acceptance

Use the existing `macos-intel-canary.yml` candidate path with a nonempty stable
numeric `candidate_version`. It calls the private release build with
`publish: false`; it must not publish a release or updater manifest. Record the
exact source SHA, remote checks and verified artifact catalog. The cumulative
branch requires its own scoped admission to `desktop-candidate`; preserve all
other environment protections. macOS packaging composes the branding overlay
without changing the account, updater trust key or sidecar list. Demo-slug
variables are rejected by the production configuration generator.

Before replacement, record the current public identity, communities and agent
configuration in a private local receipt. Quit the app, preserve its local data,
install the verified candidate with `scripts/install-macos-local.sh`, and launch
`~/Applications/el-buzz.app`. Verify strict/deep and running signatures, the
unchanged identity and communities, and the following in that same native app:

- Install/select the el-buzz theme; inspect the native icon and conversation.
  Verify theme disable/re-enable and persistence after restart.
- Inspect the project, agent, workflow and plugin icons; exercise page,
  reconnect and import activity with reduced motion and background pausing.
- Exercise an existing runtime/session plugin.
- Select text/code, submit an annotation, and navigate to its exact source.
- Enable Prompt suggestions in Experiments, insert a valid agent suggestion,
  edit it without sending, and confirm newer messages invalidate stale choices.
- Inspect highlighted code and both sides of a diff; preserve copy text.
- Open a coding thread's review, exercise split view, search and viewed-state
  persistence; confirm reply and resolve/reopen with a temporary second user.
- Complete the private Linear task → coding thread → review flow after the
  existing service/relay owner finishes admission. A fixture review alone does
  not prove that integration.

Only after account and feature acceptance, quit and reversibly archive duplicate
daily app bundles. Preserve their user data and development worktrees. Keep one
documented launch/install path. Human acceptance and repository review remain
separate requirements before marking a PR ready.

## Defect and acceptance ledger

| Finding | Disposition and owner | Validation |
| --- | --- | --- |
| Features split between different apps | Cumulative integration owner combines the pinned sources above | Source assembled; combined native acceptance pending |
| Initial branding recipe creates another account namespace | Removed identifier, demo-slug and deep-link overrides; production config rejects demo variables | Configuration regression tests pass |
| Clean CI install treats the vendored UI archive as an npm release | Pin pnpm 11.5.2, including Hermit and CI, which contains the upstream local-tarball verification fix; integration owner | Fresh empty-store frozen install passed; registry supply-chain policy remains enabled |
| Ad-hoc rebuilds invalidate remembered Keychain authorization | Stable local signer and canonical installer; cumulative integration owner | Two different synthetic signed executables read the same test item; ad-hoc negative control denied; daily candidate continuity pending |
| Local highlighting changes omitted from published feature heads | Preserved scoped source and production-renderer tests | Integration at `a4a9738c` passed 7,241 desktop tests and 29 combined browser workflows; native acceptance pending |
| Private Linear mirror is not yet admitted for the daily identity | Existing review/Linear and pilot owners continue PR42 service/relay work | Native daily-account onboarding recorded privately; live task-to-review acceptance pending |
| In-app updates do not apply the local signing certificate | Local candidate updates use the canonical signer/installer; release owner retains durable distribution signing | No claim that a remote ad-hoc updater preserves local Keychain approval |
| Duplicate daily apps remain installed | Integration owner retires them reversibly after the acceptance matrix passes | Pending; no profile data deletion authorized or required |

Source integration and focused tests are not full CI, native acceptance, a
release, or completion of duplicate retirement. Update this ledger with actual
receipts as each step completes.
