# npm packages

`querylens-cli` is a small launcher; the binary comes from one of the platform
packages (`querylens-cli-<platform>-<arch>`), listed as optional dependencies so npm
installs only the one matching the machine.

The release workflow (`.github/workflows/release.yml`) builds the binaries, stamps the
tag's version into every package, and publishes them. Nothing here is published by hand.
The unscoped name `querylens` belongs to an unrelated package on npm, hence `querylens-cli`
(the installed command is still `querylens`).

When a platform package can't be installed (npm blocked it, or `--omit=optional`), the
launcher downloads the same binary from the GitHub release, verifies it against the
release's `SHA256SUMS`, and caches it (`%LOCALAPPDATA%\querylens` or `~/.cache/querylens`).
`querylens.binaryVersion` in `querylens-cli`'s package.json says which release; it differs
from the package version only for launcher-only releases (`QUERYLENS_BINARY_VERSION`).
