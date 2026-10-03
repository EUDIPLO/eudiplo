---
title: Releases & Versioning
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - 'Backward Compatibility Policy' and 'Verifying Release Artifacts' -> upgrade/index.md; keep the maintainer part only
-->

# Versioning & Releases

This project follows a structured release strategy that balances stability with ongoing development.

## Semantic Versioning

We use **[Semantic Versioning](https://semver.org/)** (`MAJOR.MINOR.PATCH`) for all tagged releases.

- **MAJOR** – breaking changes
- **MINOR** – new features, backwards compatible
- **PATCH** – bug fixes and internal improvements

Example: `1.2.3` means the 3rd patch release of the 2nd minor version of the 1st major version.

## Development Builds from `main`

Every push to the `main` branch automatically builds a Docker image and publishes it with the `:main` tag.

Use this tag for development environments:

```bash
ghcr.io/openwallet-foundation/eudiplo:main
```

:::warning[`main` is always moving`]
`main` is always moving and may contain untagged or unreleased features.
:::

## Stable Releases

Stable releases are published via GitHub tags and follow semantic versioning. Each release creates both a versioned tag and updates the `:latest` tag:

```text
ghcr.io/openwallet-foundation/eudiplo:1.2.3
ghcr.io/openwallet-foundation/eudiplo:latest
```

The `:latest` tag always points to the most recent stable release and is recommended for production use.

## Pre-Releases

Optionally, pre-release tags such as `1.3.0-alpha.1` may be published for testing upcoming features:

```text
ghcr.io/openwallet-foundation/eudiplo:1.3.0-alpha.1
```

## Release Automation

Releases are managed using [`semantic-release`](https://github.com/semantic-release/semantic-release). It:

- Analyzes commit messages
- Determines the next version
- Publishes a GitHub release
- Pushes Docker images

Make sure to follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification when contributing to ensure proper versioning.

## Summary

| Tag                    | Source             | Use Case             |
| ---------------------- | ------------------ | -------------------- |
| `main`                 | `main` branch      | Development          |
| `latest`               | GitHub release     | Production (Latest)  |
| `x.y.z` (e.g. `1.2.3`) | GitHub release     | Specific Version     |
| `x.y.z-alpha.N`        | GitHub pre-release | Feature Preview / RC |

## Backward Compatibility Policy

- **Breaking changes only in major versions.** API field renames, removed endpoints, changed configuration formats, and new required environment variables are only introduced in major releases.
- **Deprecate before removing.** Where feasible, features are deprecated in a minor release before being removed in the next major.
- **Database migrations are automatic.** Schema changes are applied by the migration system on startup. No manual SQL is required.
- **Migration guides for every major version.** Each major release includes a step-by-step [migration guide](../upgrade/index.md) covering all required actions.
- **If it breaks in a minor/patch, it's a bug.** If you experience a breaking change outside of a major release, please [report it](https://github.com/openwallet-foundation/eudiplo/issues/new?template=bug_report.md).

## Breaking Change Checklist (for contributors)

When introducing a breaking change, ensure:

- [ ] The commit message includes `BREAKING CHANGE:` in the footer (triggers major version bump)
- [ ] The PR description lists all affected endpoints, fields, and environment variables under "Breaking Changes"
- [ ] The [migration guide](../upgrade/index.md) is updated with upgrade steps
- [ ] The `.env.example` is updated if environment variables changed
- [ ] The PR has the `breaking-change` label

## Verifying Release Artifacts

CLI release archives and `SHA256SUMS.txt` are covered by a signed GitHub build
provenance attestation. Starting with releases that include
`provenance.sigstore.json`, the same Sigstore bundle is also attached to the
release for verification after downloading it.

Download the archive for your platform and `provenance.sigstore.json` from the
same release, then verify the archive with the GitHub CLI:

```bash
gh attestation verify ./eudiplo-vX.Y.Z-linux-x64.tar.gz \
  --repo openwallet-foundation/eudiplo \
  --signer-workflow openwallet-foundation/eudiplo/.github/workflows/release.yml \
  --bundle ./provenance.sigstore.json
```

Replace `vX.Y.Z` and the platform with the archive you downloaded. For v8.0.1,
omit `--bundle` to retrieve its existing attestation from GitHub. Earlier
releases were published before build attestations were enabled.

The attestation authenticates the artifact and its producing workflow; checksums
alone only detect changes relative to the checksum file. OpenSSF Scorecard looks
for signature files attached to the last five releases, so older releases will
continue affecting that check until they leave its evaluation window.

## Signed Commits

**All commits must be signed** to pass GitHub's verification checks.

Configure GPG signing locally:

```bash
git config --global user.signingkey <key>
git config --global commit.gpgsign true
```

Or use `-S` flag when committing:

```bash
git commit -S -m "feat: add new feature"
```

For more information, see [GitHub's guide on signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits).
