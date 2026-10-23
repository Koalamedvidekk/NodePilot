# Contributing to NodePilot

Thanks for helping improve NodePilot. The user-facing installation and operation
guide is in [README.md](README.md); this file is for development and release
maintenance.

## Local development

Use Node.js 20.19 or newer, then install and verify the workspace:

```bash
npm ci
npm run check
npm test
npm run build
```

Run the development servers with `npm run dev`. Keep user data outside the
repository when testing by setting `NODEPILOT_DATA_DIR` to a temporary directory.

## Publishing a release

Maintainers publish an updater-compatible GitHub Release by making a versioned
commit on `main`, then pushing a matching annotated tag. Update the root,
client, and server package versions together and regenerate the lockfile version
entries before committing.

```bash
git tag -a vX.Y.Z -m "NodePilot vX.Y.Z"
git push origin vX.Y.Z
```

The release workflow runs type checks, tests, and a production build before it
creates the GitHub Release. It then attaches the universal updater ZIP and its
matching SHA-256 file. Do not publish a release as signed unless the repository
has separately configured and verified an artifact-signing key.
