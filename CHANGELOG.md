# Changelog

## [0.3.2] - 2026-09-05

### Fixed

- Test Bitbucket Cloud connection health against the configured workspace repository collection instead of `/2.0/user`, so a repository-scoped access token is reported as connected rather than requiring authentication.
- Keep failing closed with the existing generic health error when repository access itself is denied; Data Center continues to use its native health probe.


## [0.3.1] - 2026-09-04

### Changed

- Paginate Bitbucket Cloud and Data Center branch listings, deduplicate refs, and order recent branches first when provider metadata supports it.
- Fail closed on later-page errors and repeated or non-advancing pagination cursors.


## [0.3.0] - 2026-08-26

### Changed

- Fix OAuth callback issue on localhost (invalid Bitbucket action request.) (#10) (e899a8a)
- fix: attribute Bitbucket plugin to Kandev (#8) (0551b9d)


## [0.2.1] - 2026-08-21

### Changed

- feat: add marketplace icon (#7) (a91ea4b)
- ci: derive packaged contract artifact version (#6) (c0fb412)


## [0.2.0] - 2026-08-14

### Changed

- ci: verify packaged artifact before Bitbucket releases (#5) (66cd390)
- chore: prepare initial plugin publication (#4) (a0ee96e)
- feat: add Bitbucket Cloud and Data Center integration (#1) (e40b273)
- chore(security): bump x/net & x/text, pin CI actions to commit SHA (#3) (2ab6e5e)
- ci: add manual release workflow (71a13d0)
- Initial commit (6329785)
