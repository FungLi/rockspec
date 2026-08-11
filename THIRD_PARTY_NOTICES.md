# Third-Party Notices

RockSpec's runtime, plugin manifests, canonical Skills, Action contracts, Role prompts, Recipes, and Templates are independently implemented. The projects below were studied as design references. Their source code, Skill bodies, scripts, prompts, and assets are not copied into RockSpec release artifacts unless a future change explicitly records the copied material and satisfies its license.

Local research checkouts may exist under `docs/open-project/` in this development workspace. They are upstream source snapshots for manual study and must be excluded from RockSpec runtime/plugin release archives. Their own license files continue to govern those snapshots.

## OpenSpec

- Project: OpenSpec
- Source: https://github.com/Fission-AI/OpenSpec
- Studied snapshot: npm package version `1.8.0` in the local research checkout
- Upstream license: MIT, Copyright (c) 2024 OpenSpec Contributors
- RockSpec use: conceptual study of Spec deltas, artifact relationships, validation, status guidance, and archive lifecycle
- Distribution: not included in RockSpec runtime or plugin content

## Superpowers

- Project: Superpowers
- Source: https://github.com/obra/superpowers
- Studied snapshot: version `6.2.0` in the local research checkout
- Upstream license: MIT, Copyright (c) 2025 Jesse Vincent
- RockSpec use: conceptual study of requirements clarification, repository-first planning, Change-level Git worktree isolation, fresh per-Task implementers, test-driven work, review loops, and verification before completion
- Distribution: not included in RockSpec runtime or plugin content

## Matt Pocock Skills

- Project: Matt Pocock's Agent Skills
- Source: https://github.com/mattpocock/skills
- Studied snapshot: version `1.2.3` in the local research checkout
- Upstream license: MIT, Copyright (c) 2026 Matt Pocock
- RockSpec use: conceptual study of public-behavior testing, Spec/standards review axes, task scoping, implementation context, bug diagnosis, source-backed research, questioning discipline, and domain modeling
- Distribution: not included in RockSpec runtime or plugin content

## Comet

- Project: Comet
- Source: https://github.com/rpamis/comet
- Studied snapshot: package version `0.4.0-beta.17` in the local research checkout
- Upstream license: MIT, Copyright (c) 2026 rpamis
- RockSpec use: conceptual study of a thin debug gate that requires root-cause investigation and a failing regression test before a source fix
- Distribution: not included in RockSpec runtime or plugin content

## ui-ux-pro-max

- Project/Skill: `ui-ux-pro-max`
- Relationship: optional externally owned Capability Provider for `ui.prototype`
- Source, version, and license: not asserted by RockSpec; the currently inspected local installation does not provide enough metadata to establish a distributable upstream package and license
- RockSpec use: invoked by original Skill name through the host after capability resolution; Provider output is normalized into RockSpec Prototype artifacts and evidence
- Distribution: not bundled in the RockSpec source or npm package; the installer may copy a user-supplied local source into a target project after explicit License acceptance and records its provenance and integrity

Users and distributors must supply a trusted `ui-ux-pro-max` source and confirm that their source and use comply with the Provider's applicable terms. Its absence is a supported blocked state, not permission to fetch from an unverified source or redistribute it as part of RockSpec.
