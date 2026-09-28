#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob
apps=(dist/mac*/*.app)
images=(dist/*.dmg)
if [[ ${#apps[@]} -ne 1 || ${#images[@]} -ne 1 ]]; then
  echo "Expected one macOS application and one DMG; found ${#apps[@]} and ${#images[@]}." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "${apps[0]}"
spctl --assess --type execute --verbose=2 "${apps[0]}"
xcrun stapler validate "${apps[0]}"
echo "Verified Developer ID signature and notarization: ${apps[0]}"
