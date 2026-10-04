---
title: Releases & Versioning
---

# Releases

This page is for maintainers. Releases are created by [semantic-release](https://github.com/semantic-release/semantic-release) from the commit history of `main`; operators find the compatibility policy and how to verify artifacts in [Upgrade](../upgrade/index.md).

## Commit messages

The version bump is derived from the commits since the last tag (`.releaserc.js`, Angular preset):

| Commit | Release |
| --- | --- |
| `fix:`, `perf:`, `refactor:`, `docs(README):` | patch |
| `feat:` | minor |
| a `BREAKING CHANGE:` footer | major |
| `docs:`, `test:`, `chore:`, `ci:`, `build:` | none |

For a breaking change write both: a `!` in the header (`fix(trust)!: …`) for readers, and a `BREAKING CHANGE:` footer that says what changed and what users must do. Only the footer triggers the major release: the Angular preset does not parse `!`, so a `!` header without the footer releases nothing. The footer text ends up in the release notes. A breaking change also needs an entry in `apps/docs/docs/upgrade/<previous>.x-to-<next>.0.md`, and the PR gets the `breaking-change` label.

Every commit must carry a DCO sign-off (`git commit -s`) and be cryptographically signed. The full process rules are in [`CONTRIBUTING.MD`](https://github.com/openwallet-foundation/eudiplo/blob/main/CONTRIBUTING.MD#commits).

## Builds from `main`

Every push to `main` that passes CI publishes development artifacts. Their version is `<last release>-main.<short sha>` (`scripts/ci-version.sh`), for example `8.1.0-main.ed0bbe9`.

| Artifact | Published as |
| --- | --- |
| `ghcr.io/openwallet-foundation/eudiplo`, `eudiplo-client`, `eudiplo-demo` | `:main` and `:sha-<full commit sha>` |
| `@eudiplo/sdk-core`, `@eudiplo/cli` on npm | `<last release>-main.<short sha>` with the dist-tag `main` |

There is no alpha or beta channel. The `:main` images carry unreleased database migrations, which can still change before a release; use them only with throwaway databases.

## Cut a release

1. Check that the *CI / Docker* run for the `main` commit you want to release succeeded. The release workflow refuses commits without one.
2. In GitHub Actions, run **Versioned Release** (`.github/workflows/release.yml`) on `main`.
3. For a major version, enter `CONFIRM` in `confirm_major`. Without it the workflow stops after detecting the major bump. It also stops when there are no releasable commits. To deploy documentation-only changes without a release, check `deploy_site_only` instead (see [Documentation](./documentation.md#deployment-and-versions)).

The workflow then:

- determines the next version with a semantic-release dry run,
- builds the standalone CLI for `linux-x64`, `linux-arm64`, `macos-arm64` and `windows-x64`, writes `SHA256SUMS.txt` and a build provenance attestation (`provenance.sigstore.json`),
- runs semantic-release: sets the SDK and CLI versions, creates the tag `vX.Y.Z` and the GitHub release with the CLI archives, checksums and attestation, and publishes `@eudiplo/sdk-core` and `@eudiplo/cli` to npm with the dist-tag `latest`,
- promotes the CI images of the released commit (`:sha-<commit>`, by digest) for `eudiplo`, `eudiplo-client` and `eudiplo-demo` to `:X.Y.Z`, `:X.Y`, `:X` and `:latest` (`scripts/release-docker.sh`, `Dockerfile.release`, `linux/amd64` and `linux/arm64`),
- builds and deploys the documentation and the website to production (see [Documentation](./documentation.md#deployment-and-versions)).

Images are never rebuilt from source for a release: the tested CI image is promoted.

## Before a major release

- Every `!` commit and `BREAKING CHANGE` footer since the last tag is covered in the upgrade guide (`git log --format='%h %s%n%b' vX.Y.Z..main`).
- The guide is listed in the Upgrade sidebar and on [the upgrade overview](../upgrade/index.md).
- `eudiplo upgrade` prints `https://docs.eudiplo.dev/migration/<from>.x-to-<to>.0` for every major it crosses; add a redirect from that path to the new guide in `apps/docs/docusaurus.config.ts`.
- Configuration format changes are published: new `schemas/v*/` snapshots go live with the website deployment of the release ([Configuration schemas](./configuration-schemas.md)).
