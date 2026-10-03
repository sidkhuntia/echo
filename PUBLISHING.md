# Publishing a release

Releases are built by GoReleaser from a `v*` tag (`.github/workflows/release.yml`). Each one publishes
`echo-desk_<version>_{darwin,linux}_{arm64,amd64}.tar.gz` and `checksums.txt` to GitHub Releases, and updates
the Homebrew formula.

## One-time setup

1. Create an empty public repository `sidkhuntia/homebrew-tap`.
2. Create a fine-grained token with *Contents: read and write* on that repository only, and save it in
   this repository as the Actions secret `HOMEBREW_TAP_TOKEN`. Without it the release still publishes;
   only the formula update is skipped.
3. Optional: add a `LICENSE` file; the archives will need the `files:` entry in `.goreleaser.yaml` updated to ship it.

## Cut a release

```sh
gofmt -l . && go vet ./... && go test -race ./... && node --test web/*.test.mjs
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

## Gating

The release workflow first runs the whole CI suite (`ci.yml`: gofmt, vet, race tests on macOS and
Linux, JS tests, govulncheck) on the tagged commit. If it fails, nothing is published.

## Signing and notarization

When these Actions secrets are set, GoReleaser signs and notarizes the macOS binaries; without them the
release still publishes, unsigned (Homebrew and `install.sh` downloads are not quarantined, so they open
normally, and a tarball downloaded in a browser then needs `xattr -d com.apple.quarantine echo-desk` once).

| Secret | What |
| --- | --- |
| `MACOS_SIGN_P12` | base64 of the *Developer ID Application* certificate (.p12) |
| `MACOS_SIGN_PASSWORD` | the .p12 password |
| `MACOS_NOTARY_ISSUER_ID`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_KEY` | App Store Connect API key (issuer, key id, base64 of the .p8) |
