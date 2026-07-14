# Release Checklist

This checklist intentionally stops before `npm publish`.

## Repository

- [ ] Repository URL, issue URL, license, author, and package scope are confirmed.
- [ ] npm scope ownership and final package-name availability are confirmed.
- [ ] Version and changelog are approved.
- [x] Working tree contains only intentional release files.

## Quality gates

- [x] `npm ci`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run test:coverage`
- [x] `npm run build`
- [x] `npm run verify:package`
- [x] Windows local verification
- [x] Clean Linux verification with official Node 22 and 24 Docker images
- [ ] GitHub Actions Windows/Ubuntu/macOS matrix
- [x] Real-device E2E with cleanup

## Package review

- [x] `dist/cli.js` starts with `#!/usr/bin/env node`.
- [x] Tarball contains only `dist`, `README.md`, `LICENSE`, and `package.json`.
- [x] Clean tarball install exposes `cubic --version` and `cubic --help`.
- [x] No device IP, local config, token, auth file, test fixture, or secret is packed.
- [ ] README install commands are updated after the final package name is chosen.

## Release automation (not executed yet)

- [ ] Create the public GitHub repository.
- [ ] Create the npm package/scope and enable 2FA.
- [ ] Configure npm Trusted Publishing for the release workflow.
- [ ] Add a tag-triggered staged or `next` publishing workflow.
- [ ] Review `npm publish --dry-run` output.
- [ ] Publish `0.1.0-beta.1` with the `next` dist-tag only after approval.
