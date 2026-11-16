#!/bin/bash
# Leak scan. Run it before every push:   scripts/privacy-scan.sh [denylist-file]
#
# Looks through every file git would publish (and, once there are commits, the whole history) for:
#   1. ESPN login cookies: an espn_s2 value, or a SWID ({XXXXXXXX-XXXX-...})
#   2. files that must never be published (config.json, .env, keystores, APKs)
#   3. home network addresses (192.168.x.x, 10.x.x.x) and email addresses
#   4. your own denylist: one word or phrase per line, case-insensitive (your real league's name,
#      team names, the league ID). Default ~/.fantasybug-denylist. Keep it OUTSIDE the repo.
# It prints the file and the rule, never the text it found, so the output is safe to share.
# Exit code 0 means nothing found. Anything else: do not push.
set -u
cd "$(dirname "$0")/.." || exit 2
DENY=${1:-$HOME/.fantasybug-denylist}
FOUND=0
hit() { echo "  $1"; FOUND=$((FOUND + 1)); }

# What would be published: tracked files plus new files git does not ignore
FILES=$(git ls-files --cached --others --exclude-standard)
grep_files() {   # rule, grep options and pattern
  local rule=$1; shift
  local out
  out=$(echo "$FILES" | tr '\n' '\0' | xargs -0 grep -l -I "$@" 2>/dev/null)
  [ -n "$out" ] && echo "$out" | while read -r f; do echo "  $f: $rule"; done && return 1
  return 0
}

echo "1. ESPN cookies"
grep_files "looks like an espn_s2 value" -E 'AE[A-Za-z0-9%+/=]{80,}' || FOUND=$((FOUND + 1))
grep_files "looks like a SWID" -E '\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}' || FOUND=$((FOUND + 1))

echo "2. Files that must stay private"
echo "$FILES" | grep -E '(^|/)(config\.json|\.env.*|keystore\.properties|.*\.(jks|keystore|apk|aab))$' | while read -r f; do echo "  $f: never publish this file"; done | grep . && FOUND=$((FOUND + 1))

echo "3. Home network addresses and email addresses"
grep_files "a home network address" -E '\b(192\.168|10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b' || FOUND=$((FOUND + 1))
grep_files "an email address" -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|io|me|co|au|uk)\b' --exclude=*.svg || FOUND=$((FOUND + 1))

echo "4. Denylist"
if [ -f "$DENY" ]; then
  while IFS= read -r w; do
    [ -z "$w" ] && continue
    grep_files "a word from your denylist" -i -w -F -- "$w" || FOUND=$((FOUND + 1))
  done < "$DENY"
else
  echo "  (no denylist at $DENY: skipped)"
fi

if git rev-parse HEAD > /dev/null 2>&1; then
  echo "5. Git history"
  H=$(git log -p --all 2>/dev/null)
  echo "$H" | grep -qE 'AE[A-Za-z0-9%+/=]{80,}' && hit "history: an espn_s2-like value"
  echo "$H" | grep -qE '\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}' && hit "history: a SWID-like value"
  if [ -f "$DENY" ]; then
    while IFS= read -r w; do [ -n "$w" ] && echo "$H" | grep -qiwF -- "$w" && hit "history: a word from your denylist"; done < "$DENY"
  fi
fi

if [ "$FOUND" = 0 ]; then echo "Clean: nothing found."; exit 0; fi
echo "Found $FOUND problem(s). Do not push until they are fixed."
exit 1
