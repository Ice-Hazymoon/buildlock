#!/usr/bin/env bash
# Prepares a release: scripts/release.sh 0.2.1
#
# Sets bl_version in bin/buildlock, checks that CHANGELOG.md has a "## 0.2.1"
# section, runs the checks, commits and tags v0.2.1. Pushing the tag
# (git push origin main v0.2.1) publishes the release from GitHub Actions.
set -euo pipefail

version="${1:?usage: scripts/release.sh X.Y.Z}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "not a version: $version" >&2; exit 1; }
cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || { echo "commit or stash your changes first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" > /dev/null && { echo "tag v$version exists" >&2; exit 1; }
grep -qx "## $version" CHANGELOG.md || { echo "CHANGELOG.md needs a '## $version' section" >&2; exit 1; }

sed -i "s/^bl_version=.*/bl_version=$version/" bin/buildlock
shellcheck bin/buildlock install.sh scripts/release.sh
if command -v buildlock > /dev/null; then BUILDLOCK_CLASS=light buildlock bun test; else bun test; fi

# bl_version may already be set (bumped along with the changes it releases).
git diff --quiet || git commit -am "buildlock $version"
git tag -a "v$version" -m "buildlock $version"
echo "Tagged v$version. Publish with: git push origin HEAD v$version"
