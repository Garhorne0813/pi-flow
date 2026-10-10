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

Automated release checks (#21):

  npm run verify:vendor             # archive/lock + actual installed tree + SBOM
  npm run verify:vendor:upstream    # also compare Pi and rebuild pinned Cube source

vendor/provenance.json pins archive SHA-512, versions/licenses and the Cube source
archive at the immutable commit. CI compares every Pi file byte-for-byte except
npm-shrinkwrap.json, whose sole permitted change is the documented brace entry;
Cube is rebuilt with the upstream lock and compared by unpacked file contents
(tar timestamps do not affect comparison). npm ci --ignore-scripts is used for
upstream install, followed only by the documented build/pack commands.
Installed dependency versions are checked against the full lock, including the
nested Pi brace-expansion, rather than trusting root audit output.

CI saves a CycloneDX dependency inventory, commit, provenance and license files as
an artifact named for the exact release commit. License UNKNOWN entries require
release review; this inventory is not a legal license determination. Runtime startup
does not invoke any verification/download/build command, and TLS stays enabled.

Upgrade: update trusted upstream metadata and immutable source commit, reproduce
archives, inspect the allowed diff, update lock/provenance, then run upstream
verification and Pi/MCP/Remote/Sandbox isolation/lifecycle regressions. The
supply-chain PR check runs these contract tests even when application CI is separate.
If a security fix or SDK contract fails, block release and retain the previous
verified artifacts. Roll back to the previous release image after stopping new
Runs; never install a fallback SDK during production startup or automatically
replay uncertain tools. A rollback that reintroduces a security defect requires
an explicit deployment risk decision rather than silently disabling the check.
