# el-buzz icons and motion

Canonical source: `@el/ui/Buzz` in el-lander, distributed as `@el/buzz-ui` 0.2.0.
The approved bee logo supplies the silhouette, dotted construction guides, sage
outline and pink registration marks. Twelve 24-unit product glyphs use a
1.5-unit stroke. Small controls use simple monochrome glyphs; the large bee
illustration retains construction detail.

The app uses the new project, agent and workflow icons in navigation and the
plugin glyph in plugin rows. Loading pages use the bee, reconnecting uses a
dotted transfer path, and imports use compact dots. Existing content skeletons,
controls, persistence and account configuration are preserved. Each activity
indicator owns one status label, or is decorative under an already named host.

Motion uses CSS only. IntersectionObserver and document visibility pause hidden
indicators; unmount disconnects the observer and listener. Reduced motion keeps
static artwork. No synthetic completion percentage or minimum loading time is
introduced.

Validation: shared ESM/declaration build, desktop TypeScript, four DOM tests
bound to production exports/consumers, browser live animation/pause/reduced
motion, 16px sizing, desktop/mobile screenshots, no narrow-screen overflow and
a clean browser console. The reduced-motion specificity defect found during
browser checking was fixed in canonical CSS and the browser assertions passed.
Native cumulative integration and account acceptance remain owned by the
existing cumulative app build; no separate app is installed by this change.
