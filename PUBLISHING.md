# Publishing

Two packages, one version number: `@scrapier/cli` on npm and `scrapier` on PyPI.

## One-time setup (owner)

1. **npm:** the npm user `scrapier` owns the `@scrapier` scope, so no organization is needed.
2. **PyPI:** create an account at pypi.org and turn on 2FA. The first upload of `scrapier` claims the name.
3. **GitHub:** create `devscraper-007/scrapier-cli` and push this repo.

## Before every release

1. Bump the version in **both** `node/package.json` and `python/src/scrapier/__init__.py`. The tests fail if they differ.
2. Copy the README and LICENSE into both packages: `for d in node python; do cp README.md LICENSE $d/; done`. The tests fail if the READMEs differ.
3. Run the tests: `node --test tests/cli.test.mjs`. They run the Node and Python CLIs against a mock API and require identical output.
4. Commit, and tag `vX.Y.Z`.

## Publish

Push a version tag. GitHub Actions tests both CLIs and publishes both packages,
with no tokens (Trusted Publishing on PyPI and npm):

```bash
git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
```

- PyPI: `.github/workflows/publish-pypi.yml`, trusted publisher on pypi.org (account `scrapier`), environment `pypi`.
- npm: `.github/workflows/publish-npm.yml`, trusted publisher in the `@scrapier/cli` package settings on npmjs.com, environment `npm`.

v0.1.0 on npm was published by hand (`npm login && npm publish --access public` in node/), because npm only lets you add a trusted publisher to a package that already exists.

## Check the release

```bash
npx -y @scrapier/cli@latest --version
pipx run --no-cache scrapier --version
```
