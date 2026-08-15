Every shipped .dmg lives here, one file per version. Nothing in this folder
is ever overwritten or deleted — `npm run release` refuses to reuse a version,
whatever architecture suffix the existing installer carries.

The files themselves are gitignored (~700 MB each) and published as GitHub
Release assets by `.github/workflows/release-dmg.yml`. `../RELEASES.md` is the
committed record of what exists; see BUILD.md ▸ "Cutting a release".
