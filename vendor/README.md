CubeSandbox Node SDK 0.3.0 is built from TencentCloud/CubeSandbox commit
2bbaf74ba7565992ec2a3dbc9928ed5b720639a2 (Apache-2.0).
The npm package was unavailable at implementation time. Reproduce with:
  curl -fL https://codeload.github.com/TencentCloud/CubeSandbox/tar.gz/2bbaf74ba7565992ec2a3dbc9928ed5b720639a2 -o source.tgz
  tar xf source.tgz
  cd CubeSandbox-*/sdk/node
  npm ci && npm run build && npm pack
The package-lock.json records the vendored archive integrity. No runtime installation.

Pi Coding Agent SDK 0.99.2 is the official npm release, repacked with exactly
one metadata change: its npm-shrinkwrap.json pins brace-expansion 5.0.12 rather
than 5.0.9, addressing GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7 and
GHSA-6j4f-fj2g-mc7p. SDK source, dist files and APIs are unchanged. The bundled
CLI remains the original artifact and is not invoked by this Harness.

The original npm tarball integrity is recorded in pi-original-dist.json;
brace-fixed-dist.json records the replacement dependency's registry integrity.
The root package-lock records the repacked archive integrity. MIT license is
included in Pi-LICENSE. Reproduce from the official npm tarball:

  npm pack @earendil-works/pi-coding-agent@0.99.2 --ignore-scripts --pack-destination work
  node scripts/repack-pi-sdk.mjs work/earendil-works-pi-coding-agent-0.99.2.tgz vendor/pi-original-dist.json vendor/brace-fixed-dist.json vendor/pi-coding-agent-0.99.2-harness.tgz

Use npm ci for normal installs. Plain overrides/audit fix did not supersede the
upstream nested shrinkwrap; checking only the root lock reported a clean audit
while actually installing 5.0.9. This repack makes installed and recorded
versions agree. Always check the installed version and rerun contract tests
when refreshing the SDK package.
