# Publishing a release

Releases are built by GoReleaser from a `v*` tag (`.github/workflows/release.yml`). Each one publishes
`echo-desk_<version>_darwin_{arm64,amd64}.tar.gz` and `checksums.txt` to GitHub Releases, and updates
the Homebrew formula.

## One-time setup

1. Create an empty public repository `sidkhuntia/homebrew-tap`.
2. Create a fine-grained token with *Contents: read and write* on that repository only, and save it in
   this repository as the Actions secret `HOMEBREW_TAP_TOKEN`. Without it the release still publishes;
   only the formula update is skipped.
3. Optional: add a `LICENSE` file; the archives will need the `files:` entry in `.goreleaser.yaml` updated to ship it.

## Cut a release

```sh
gofmt -l . && go vet ./... && go test ./...
git tag v0.1.0
git push origin v0.1.0
```

Try the build locally first (nothing is published):

```sh
HOMEBREW_TAP_TOKEN=x goreleaser release --snapshot --clean --skip=publish
```

## Verify

```sh
brew install sidkhuntia/tap/echo-desk && echo-desk -version
curl -fsSL https://raw.githubusercontent.com/sidkhuntia/echo/main/install.sh | sh
```

## Signing

The binaries are not Apple-notarized. Homebrew and `install.sh` downloads are not quarantined, so they
open normally; a tarball downloaded in a browser needs `xattr -d com.apple.quarantine echo-desk` once.
