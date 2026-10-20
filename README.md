# Stick Labs

Stick Labs is a Windows-first Electron app for tuning wired GameSir controllers
over HID. It supports full profile editing on the GameSir G7 Pro 8K and
Tarantula 8K (T3CE). The LeadJoy Saber Plus has its own protocol and supports
button remaps, stick curves and zones, read-only trigger deadzones, and
controller-rate settings. Other listed models are detect-only or unsupported; profile editing
stays locked unless the model's wire format has been verified.

The app includes staged edits with verified writes, curve and deadzone tools,
button remapping, profiles, calibration, diagnostics, Steam configuration
export, and USB polling analysis. The exact available screens depend on the
edition being built.

## Web version

Stick Labs also runs in the browser, with nothing to install:
**https://realkiyoshii.github.io/stick-labs/**

- Works in Chrome, Edge, Vivaldi and Opera (they support WebHID). Firefox and
  Safari can't talk to controllers.
- Supports the same controllers as the desktop app: GameSir G7 Pro 8K and
  Tarantula 8K, plus LeadJoy Saber Plus and Xeno Pro. Writes use the same
  verified read-back as the desktop app.
- Click **Rescan USB** and pick your controller in the browser's prompt. Close
  GameSir Connect or the LeadJoy app first.
- Desktop only: the kernel polling-rate check and the Steam/Apex config export,
  since a web page can't reach those parts of Windows.

The site is rebuilt and published automatically with every release.

## Requirements

- Windows
- Node.js and dependencies installed with `npm install`
- Close GameSir Connect or the LeadJoy vendor app before connecting; they can
  hold the controller's HID interface

## Development

Use `node` to run project tools in this Windows environment:

```powershell
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
node scripts/test.mjs
node node_modules/electron-vite/bin/electron-vite.js build
Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList "."
```

To run one deterministic test file, pass its path, for example:

```powershell
node scripts/test.mjs tests/leadjoy.ts
```

Live hardware probes are opt-in and are not part of the default test suite.
Do not run them as ordinary tests: hardware writes require explicit per-step
confirmation, a closed vendor app, and verified readback/restore behavior.

## Build Windows installers

```powershell
node node_modules/electron-vite/bin/electron-vite.js build
node node_modules/electron-builder/out/cli/cli.js --win
```

The app reads `out/` at launch, so rebuild before starting it after code
changes. Installer and portable artifacts are written under `dist/`.

## Device safety

- Devices are opened by vendor ID plus HID usage page and usage, never by PID.
- Profile and setting writes use read-modify-write, acknowledgement, and
  readback verification; a mismatch triggers a restore attempt.
- Writing the active GameSir profile can reboot the controller for one to two
  seconds.
- Do not release a build unless the release is explicitly requested. See
  `AGENTS.md` for project architecture, hardware rules, edition conventions,
  and release workflow.
