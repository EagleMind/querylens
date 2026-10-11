# npm packages

`querylens-cli` is a small launcher; the binary comes from one of the platform
packages (`querylens-cli-<platform>-<arch>`), listed as optional dependencies so npm
installs only the one matching the machine.

The release workflow (`.github/workflows/release.yml`) builds the binaries, stamps the
tag's version into every package, and publishes them. Nothing here is published by hand.
The unscoped name `querylens` belongs to an unrelated package on npm, hence `querylens-cli`
(the installed command is still `querylens`).
