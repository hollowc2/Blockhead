#!/usr/bin/env bash
# Builds gesture-observer.jar with any JDK 21+ javac (no dependencies) and the
# self-test classes. Usage: build.sh [output-dir]. Prints the jar SHA-256.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/build}
rm -rf "$out"
mkdir -p "$out/classes" "$out/test-classes"
javac --release 21 -Xlint:all -Werror -d "$out/classes" $(find "$here/src/main/java" -name '*.java' | sort)
printf 'Premain-Class: blockhead.observer.Agent\nBoot-Class-Path: gesture-observer.jar\nCan-Retransform-Classes: true\nCan-Redefine-Classes: false\n' > "$out/MANIFEST.MF"
# Sorted entries and a fixed timestamp keep the jar byte-reproducible for a given javac.
(cd "$out/classes" && jar --create --file "$out/gesture-observer.jar" --manifest "$out/MANIFEST.MF" --date=2026-10-29T00:00:00Z $(find . -type f | sort | sed 's|^\./||'))
javac --release 21 -Xlint:all -d "$out/test-classes" -cp "$out/classes" $(find "$here/src/test/java" -name '*.java' | sort)
sha256sum "$out/gesture-observer.jar"
