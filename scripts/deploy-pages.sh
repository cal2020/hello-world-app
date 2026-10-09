#!/usr/bin/env sh
# Publish the public build (no interview notes) to the root of the gh-pages
# branch. Other apps deployed in subfolders of gh-pages are left untouched,
# so do not replace this with a tool that rewrites the whole branch.
#
# Usage: npm run deploy:pages    (REMOTE=<name or path> to target another remote)
set -eu

REMOTE="${REMOTE:-origin}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first; the deploy is labeled with the current commit." >&2
  exit 1
fi

npm run -s build:public

WORK="$(mktemp -d)"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

git fetch -q "$REMOTE" gh-pages
git worktree add -q --detach "$WORK" FETCH_HEAD

# Replace only the files this app owns at the site root.
git -C "$WORK" rm -rq --ignore-unmatch index.html vite.svg assets
cp -R dist/. "$WORK/"
touch "$WORK/.nojekyll"
git -C "$WORK" add -A

if git -C "$WORK" diff --cached --quiet; then
  echo "gh-pages already serves this build; nothing to deploy."
  exit 0
fi

git -C "$WORK" commit -q -m "Deploy Evidence Link Bench $(git rev-parse --short HEAD) at site root"
git -C "$WORK" push -q "$REMOTE" HEAD:gh-pages
echo "Deployed. GitHub Pages usually updates within a minute."
