# Release Checklist

This checklist covers the first stable npm release and its OIDC release path.

## Repository

- [x] Repository URL, issue URL, license, author, and package scope are confirmed.
- [x] npm scope ownership and final package-name availability are confirmed.
- [x] Version and changelog are approved.
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
- [x] GitHub Actions Windows/Ubuntu/macOS matrix
- [x] Real-device E2E with cleanup

## Package review

- [x] `dist/cli.js` starts with `#!/usr/bin/env node`.
- [x] Tarball contains only `dist`, `README.md`, `LICENSE`, and `package.json`.
- [x] Clean tarball install exposes `cubic --version` and `cubic --help`.
- [x] No device IP, local config, token, auth file, test fixture, or secret is packed.
- [x] README install commands are updated after the final package name is chosen.

## Release automation

- [x] Create the public GitHub repository.
- [x] Confirm the npm account owns the `princival` scope.
- [x] Configure npm Trusted Publishing for the release workflow.
- [x] Add the tag-triggered `publish-node.yml` OIDC workflow.
- [x] Review `npm publish --dry-run` output.
- [ ] Publish `0.1.0` with the `latest` dist-tag.
