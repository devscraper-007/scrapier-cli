# Publishing

Two packages, one version number: `@scrapier/cli` on npm and `scrapier` on PyPI.

## One-time setup (owner)

1. **npm:** sign in at npmjs.com, then create the organization `scrapier` (free plan, public packages). That org owns `@scrapier/cli`.
2. **PyPI:** create an account at pypi.org and turn on 2FA. The first upload of `scrapier` claims the name.
3. **GitHub:** create `scrapierio-ai/scrapier-cli` and push this repo.

## Before every release

1. Bump the version in **both** `node/package.json` and `python/src/scrapier/__init__.py`. The tests fail if they differ.
2. Copy the README and LICENSE into both packages: `for d in node python; do cp README.md LICENSE $d/; done`. The tests fail if the READMEs differ.
3. Run the tests: `node --test tests/cli.test.mjs`. They run the Node and Python CLIs against a mock API and require identical output.
4. Commit, and tag `vX.Y.Z`.

## Publish

```bash
# npm (from node/)
cd node
npm publish --access public          # asks for your npm 2FA code

# PyPI (from python/)
cd ../python
rm -rf dist && uv build              # or: python3 -m build
uvx twine upload dist/*              # username __token__, password = a PyPI API token
```

## Check the release

```bash
npx -y @scrapier/cli@latest --version
pipx run --no-cache scrapier --version
```
