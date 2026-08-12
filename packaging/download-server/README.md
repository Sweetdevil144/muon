# MUON download host — `download.getmuon.com`

A dependency-free static file server for MUON release artifacts, run as a
Railway service with a volume. It is the single distribution origin: the
website's download button, the `electron-updater` feed
(`apps/desktop/electron-builder.yml`, `publish: generic`) and
`getmuon.com/install.sh` both point
here.

## What it serves (one flat directory, the volume)

| Artifact | Consumed by |
|---|---|
| `MUON-<version>-arm64.dmg` | the website download button, checksum-verifying users |
| `MUON-latest-arm64.dmg` | the website's download button (stable URL) |
| `MUON-<version>-arm64.zip` + `.blockmap` | electron-updater |
| `latest-mac.yml` | electron-updater update checks (served `no-cache`) |
| `SHA256SUMS` | humans verifying downloads |
| `muon-cli-<version>.tgz` | `install.sh` (npm installs this tarball) |
| `muon-cli-latest.tgz` | `install.sh` (stable URL) |

Anything with `latest` in the name (and the feed) is served `no-cache`;
versioned artifacts are cached as immutable. No writes, no auth, no
directory traversal; `/` prints a curated name+size index and `/healthz`
answers the Railway healthcheck.

## One-time setup (founder, Railway CLI)

```bash
cd packaging/download-server
railway init                      # or: railway link (existing project)
railway volume add --mount-path /data
railway up                        # deploys this directory
railway domain                    # then add download.getmuon.com as the
                                  # custom domain and create the CNAME it prints
```

## Per release: upload artifacts

The volume is written through a one-off shell on the service (Railway
volumes are not directly writable from your laptop):

```bash
# 1. Build + verify locally (see PRE-RELEASE.md), then stage a copy dir:
#    apps/desktop/release/{MUON-*.dmg,MUON-*.zip,*.blockmap,latest-mac.yml,SHA256SUMS}
#    apps/cli/release → npm pack → muon-cli-<version>.tgz
# 2. Serve the staging dir briefly from your laptop (any tunnel works), or
#    push the files through `railway ssh` piping:
tar cz -C <staging-dir> . | railway ssh "tar xz -C /data"
# 3. Create the stable aliases inside the volume:
railway ssh "cp /data/MUON-<v>-arm64.dmg /data/MUON-latest-arm64.dmg && cp /data/muon-cli-<v>.tgz /data/muon-cli-latest.tgz"
```

Verify after upload: `curl -sI https://download.getmuon.com/latest-mac.yml`
(expect `200` + `cache-control: no-cache`) and
`curl -s https://download.getmuon.com/ | head`.

## Local check

`npm test` boots the real server against a temp dir and verifies health,
artifact roundtrip, traversal refusal, and feed cache headers.
