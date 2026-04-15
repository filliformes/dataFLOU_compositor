# Pre-built installers

Binary installers for each version are attached to that version's **GitHub Release**, not committed into this folder. GitHub rejects individual files over 100 MB in a normal push, which the `.dmg` exceeds, so Release assets are the only sensible way to host them.

## Download

Latest release: https://github.com/fillioning/dataFLOU_compositor/releases/latest

All releases: https://github.com/fillioning/dataFLOU_compositor/releases

Each release page has:

| File | Platform | Notes |
| --- | --- | --- |
| `dataFLOU_compositor-<v>-portable.exe` | Windows x64 | Double-click to run. No installation, no admin rights. |
| `dataFLOU_compositor-<v>-win-x64.exe` | Windows x64 | NSIS installer — lets you pick an install location. |
| `dataFLOU_compositor-<v>-mac-universal.dmg` | macOS (Intel + Apple Silicon) | Unsigned — see note below. |

## Installing the `.dmg` on macOS

The build is unsigned, so macOS Gatekeeper will warn the first time you open the app:

1. Open the `.dmg`, drag the app into `Applications`.
2. **Right-click** the app in Applications → **Open** → confirm the prompt.
3. It'll launch, and future launches work normally.

## Rebuilding

To produce these artifacts from source on any platform:

- **From Windows or macOS locally** — `npm run build:win` / `npm run build:mac` (the one matching your OS).
- **Both platforms at once, no Mac needed** — trigger the `Build installers` workflow from the Actions tab. It spins up real runners and uploads the artifacts to the run. See [`.github/workflows/build.yml`](../.github/workflows/build.yml).
