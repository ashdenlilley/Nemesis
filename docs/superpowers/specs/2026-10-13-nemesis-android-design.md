# Nemesis Android App: Design

Status: draft for review. No implementation has started.

## Goal

A self-contained Android APK that runs Nemesis on a Pixel 9 Pro XL under GrapheneOS, with a full terminal and a bundled userland. Nothing is installed from outside the app. Personal sideload only.

## Decisions from the interview

| Topic | Decision |
|---|---|
| Audience | Personal sideload. No store, no public release. |
| Runtime | Bundled Node binary (arm64) under a PTY, rendered by a native Android terminal view. |
| Files | Full shared storage via `MANAGE_EXTERNAL_STORAGE`. Nemesis's permission prompts for writes and shell commands stay on. |
| Keys | Cloud provider keys encrypted with an Android Keystore key. |
| Import | One-time import of `~/.nemesis/config.json` and `.env` from a file the user picks. |
| Userland | Full terminal userland with a package manager, built from our own package set. |
| Target | arm64-v8a only. |

## Non-goals

- Play Store or F-Droid distribution, reproducible builds, a privacy policy.
- iOS, x86, or emulator support as a release target.
- Local models on the phone.
- Changing Nemesis's desktop behaviour.

## Architecture

```
APK (Kotlin app, targetSdk to be pinned in M0)
├── Terminal UI      native terminal view (Termux terminal-view), PTY via JNI
├── Launcher         sets env (keys from Keystore), prefix, cwd, then execs the shell
├── Keystore wrapper AES-GCM key in Android Keystore wraps provider keys
├── Importer         SAF file picker, reads desktop config, moves keys into Keystore
├── Userland         our build of the termux-packages set, prefix under app data
│   ├── bash, coreutils, busybox-style tools, git, curl, ssh, python
│   ├── node (arm64, built with NDK from the termux nodejs recipe)
│   └── pkg (package manager) against our own repo
└── Nemesis          copied from this repo's bin/ and src/ into app assets
```

The Nemesis code has no npm runtime dependencies, so there is no install step at first launch. The app runs `node bin/nemesis.js` from the userland prefix.

## Key design points

### Running binaries on Android
Android blocks exec of files in app data for newer target SDKs. Two routes:
- Ship native binaries as `lib*.so` in `jniLibs`. They land in `nativeLibraryDir`, which is executable. This is the preferred route.
- Target an older SDK, as Termux does. Rejected: it locks us to old platform behaviour.

M0 must prove the `jniLibs` route works on the device for `node` and `bash`.

### Page size
Android 15+ supports 16 KB pages. Build all native code with 16 KB alignment so it runs on Pixel 9 Pro XL with current Android.

### Storage and sandbox
`MANAGE_EXTERNAL_STORAGE` gives Nemesis access to the whole shared storage. The sandbox is therefore the permission prompts in Nemesis, not the Android filesystem. Writes and shell commands keep their prompts. The app does not grant itself any wider access.

### Keys
- A Keystore AES-GCM key wraps the provider keys. Keys are never written to disk in plain text.
- At launch the app decrypts them and passes them to Node as environment variables. Nemesis reads them from env, so `~/.nemesis/.env` is not created on the device.
- `config.json` (non-secret) is stored in the app's home (`~/.nemesis`) as usual.

### Import
- The user picks a folder or files with the Storage Access Framework.
- `config.json` is copied into the app home. Key values in `.env` move to Keystore. The source files are never modified or deleted.
- Import runs once. A re-run needs an explicit action.

### Userland
- Built from termux-packages build scripts with our own prefix (`/data/data/<app id>/files/usr`).
- Our own package repo, so `pkg install` works against our builds.
- Node is built with the NDK using the termux nodejs recipe. Node does not ship official Android builds, so this is the main build risk.

### Terminal behaviour
- Nemesis's shell tool uses `spawn` with pipes, not a PTY. This is fine for its tool calls.
- The user's interactive shell runs in a real PTY, so `vim`, `htop` and similar tools work.

## Build and toolchain

Not installed yet. Needs approval before install (several GB):
- JDK 17
- Android SDK (platform and build-tools pinned in M0)
- Android NDK (version pinned in M0)
- Gradle wrapper in the project

The current Mac has no Android SDK or NDK, and `java` is a stub that fails.

## Signing and install

- A release keystore for the APK, kept outside the repo.
- Sideload with `adb install` or by opening the APK. GrapheneOS asks for per-app "install unknown apps" permission.
- Updates are new APKs signed with the same key.

## Milestones

- **M0: feasibility spike.** Confirm `node` and `bash` run from `jniLibs` on the Pixel 9 Pro XL, with 16 KB alignment. Build the Node binary. Requires toolchain install approval.
- **M1: terminal app.** Native terminal view with PTY running the userland `bash`. Package and prefix set up.
- **M2: Nemesis runs.** Nemesis launched from the app. Key storage via Keystore. Env injection.
- **M3: import.** Desktop config import, one-time.
- **M4: userland packages.** The package set, `pkg`, and our repo.
- **M5: acceptance on device.** Run a real Nemesis session on the Pixel 9 Pro XL.

## Testing

- Unit tests for the importer and the Keystore wrapper, run with Gradle.
- A Node smoke test that runs `bin/nemesis.js --help` inside the userland prefix on the host.
- Device acceptance (M5): a session that reads a file, runs a git command, and calls a provider with a Keystore key.
- Existing `npm test` in the repo must keep passing. No changes to Nemesis's desktop code are planned.

## Open items for review

1. App id and display name.
2. Target SDK (pinned in M0 based on what the `jniLibs` route needs).
3. Termux terminal-view and termux-packages are GPL-licensed. Fine for personal sideload; revisit if sharing.
4. Node Android build: confirm the termux recipe builds the Node version we want.
5. Whether to delete the imported `.env` source file. Current plan: never touch it.

## Risks

- Node on Android may need patches; the build could take the longest.
- `jniLibs` exec route may be restricted on newer Android; M0 tests this first.
- Maintaining our own package set is ongoing work, not a one-off.
