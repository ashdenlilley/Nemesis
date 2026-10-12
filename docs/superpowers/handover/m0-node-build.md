# Handover: M0 native build for Nemesis Android

Read first: `docs/superpowers/specs/2026-10-13-nemesis-android-design.md` (approved design).

## Goal

Build Node and bash for Android aarch64, packaged under the app id `com.ashdenlilley.nemesis`, so the probe app can run them from `nativeLibraryDir`. This is milestone M0 from the spec. The phone is a Pixel 9 Pro XL on GrapheneOS, arm64 only.

## Approved decisions

- Personal sideload only. App name `Nemesis`, app id `com.ashdenlilley.nemesis`.
- Bundled Node and a full userland built from our own termux-packages set, not Termux's repo.
- Native binaries ship as `lib*.so` in `jniLibs` so they can be exec'd on Android.
- arm64-v8a only.
- Do not install or change product dependencies beyond the M0 toolchain without asking.

## Current state

- **Repo** (`~/Developer/Nemesis`, branch `main`, nothing committed by us):
  - `docs/superpowers/specs/2026-10-13-nemesis-android-design.md`: approved spec.
  - `docs/superpowers/handover/m0-node-build.md`: this file.
  - `android/`: Gradle probe app. Builds with `./gradlew :app:assembleDebug`. Expects `libnode.so` and `libbash.so` in `app/src/main/jniLibs/arm64-v8a/` (that folder is git-ignored). It runs each with `-e` / `-c` and shows output.
  - `.gitignore`: added `android/local.properties`, `android/.gradle/`, `android/build/`, `android/app/build/`, `android/app/src/main/jniLibs/`.
- **Local toolchain** (macOS, arm64): JDK 17 at `/opt/homebrew/opt/openjdk@17`; Android SDK at `/opt/homebrew/share/android-commandlinetools` with platform 35, build-tools 35.0.0, NDK 27.2.12479018, platform-tools; Gradle 9.8.1 from Homebrew (the project pins 8.11.1 via wrapper). Adb 1.0.41.
- **Build clone**: `~/Developer/nemesis-android-build/termux-packages`, shallow clone of termux/termux-packages. Local edit: `scripts/properties.sh` line 467 set `TERMUX_APP__PACKAGE_NAME="com.ashdenlilley.nemesis"` (original backed up as `properties.sh.bak`). This edit must be re-applied on any fresh clone.

## Build attempt so far

Command that ran (from the clone root, on macOS with OrbStack):

```sh
TERMUX_DOCKER_RUN_EXTRA_ARGS="--cap-add SYS_ADMIN --device /dev/fuse --security-opt seccomp=unconfined --security-opt apparmor=unconfined" \
  ./scripts/run-docker.sh ./build-package.sh -a aarch64 nodejs
```

- Builder image `ghcr.io/termux/package-builder` is amd64 and ran under emulation on an arm64 host.
- Node recipe: `packages/nodejs/build.sh`, version 26.4.0.
- Dependencies built fine, including `resolv-conf`, and termux-elf-cleaner ran.
- **Failure (exit 2):** during packaging, `tar` fails with `Function not implemented` on basic creates and opens inside the container (`./etc/hosts`, `./lib/...`, `./share/doc/resolv-conf/copyright`). A path with a literal colon (`lib/pkgconfig\:/data/data/...`) was also created, which suggests a variable is being joined wrongly. Not yet known whether the package-name edit causes the colon path.
- Ruled out: missing `/dev/fuse`. It's exposed when the flags above are passed.
- Not tested yet: whether reverting the package-name edit to `com.termux` makes the build succeed.

## Next steps for the new session

1. Reproduce the build on a Linux x86_64 host with Docker and FUSE. Confirm the container can mount fuse-overlayfs first, e.g. `docker run --rm --cap-add SYS_ADMIN --device /dev/fuse alpine ls -l /dev/fuse`.
2. Try `build-package.sh -a aarch64 nodejs` with the same package-name setting. If the colon path appears again, check whether the package-name change causes it by testing `com.termux` first.
3. Build `bash` for aarch64 the same way.
4. Copy the resulting binaries to `android/app/src/main/jniLibs/arm64-v8a/` as `libnode.so` and `libbash.so`. Also copy any shared libraries they need (e.g. `libc++_shared.so`), and check with `readelf -d`.
5. Build the APK: `cd android && ./gradlew :app:assembleDebug`. Output: `android/app/build/outputs/apk/debug/app-debug.apk`.
6. On the Mac with the Pixel connected by USB (developer options and USB debugging on), run `adb install -r` and launch the app. Report the output shown on screen.

## Open questions

- The user has not yet decided whether to push this work to a remote, which a cloud session would need. Pushing is outward-facing, so ask before doing it.
- The user has not decided whether to switch to a prebuilt Node for Android (e.g. nodejs-mobile). That would change the approved option 2, so don't do it without asking.

## Constraints

- Don't commit or push unless the user asks.
- Don't install product dependencies beyond the M0 toolchain without asking.
- Don't rename or delete files in the user's Nemesis repo except the android/ and docs/ paths listed above.
