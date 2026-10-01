# Force to main v<version>

## Purpose

Release the pinned alpha tip as v<version> (tested first as a running main build) and publish the website reviewed against
that same build.

## Waiting on you

Nothing.

## Steps

- [ ] [Release candidate and approvals](active/force-to-main-<version>/step1-release-candidate.md)
  - [ ] Changelog and running main build approved together before website work
- [ ] [Website phase A: review and capture list](active/force-to-main-<version>/step2-website-a.md)
  - [ ] Guides reviewed against the approved build; capture list ready
- [ ] [Website phase B: captures](active/force-to-main-<version>/step3-website-b.md)
  - [ ] Cheaper agent saved and reported every requested image
- [ ] [Website phase C: place and check](active/force-to-main-<version>/step4-website-c.md)
  - [ ] Images accepted, privacy checked, website gates passed, changes committed on develop
- [ ] [Promotion and final review](active/force-to-main-<version>/step5-promote-review.md)
  - [ ] Pinned release passes preview and final review; user approves the exact commit
- [ ] [Push and demo](active/force-to-main-<version>/step6-push-demo.md)
  - [ ] Main release and public demo verified; local develop safely reconciled

## Where we are

- Starting branch, working-tree state, and local develop tip: <record>
- Pinned alpha hash/version and running candidate: <record>
- Current phase and completed checks: <record>
- Waiting on and next action or handoff: <record>
