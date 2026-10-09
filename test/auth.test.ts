import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { authFromEnv } from "../src/auth.js";
test("UCS verifies JWT signature, issuer, audience, expiry and trusted tenant claims", async () => {
  await mkdir("work/auth-tls", { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "work/auth-tls/key.pem",
      "-out",
      "work/auth-tls/cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile("work/auth-tls/cert.pem", "utf8");
  const old = getCACertificates("default");
  setDefaultCACertificates([...old, cert]);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  const server = createServer(
    { key: await readFile("work/auth-tls/key.pem"), cert },
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.HARNESS_MODE = "production";
  process.env.UCS_JWKS_URL = `https://localhost:${port}/jwks`;
  process.env.UCS_ISSUER = "https://ucs.example";
  process.env.UCS_AUDIENCE = "harness";
  try {
    const auth = authFromEnv();
    const sign = (
      audience = "harness",
      expiry = "1h",
      claims: Record<string, unknown> = {
        tenant_id: "tenant-a",
        roles: ["harness-admin"],
      },
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setSubject("user-a")
        .setIssuer("https://ucs.example")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiry)
        .sign(privateKey);
    const token = await sign();
    assert.deepEqual(await auth(`Bearer ${token}`), {
      userId: "user-a",
      tenantId: "tenant-a",
      admin: true,
      expiresAt:
        JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
          .exp * 1000,
    });
    await assert.rejects(auth(`Bearer ${await sign("wrong")}`), {
      code: "UNAUTHENTICATED",
    });
    await assert.rejects(auth(`Bearer ${await sign("harness", "-1h")}`), {
      code: "UNAUTHENTICATED",
    });
    await assert.rejects(auth(`Bearer ${await sign("harness", "1h", {})}`), {
      code: "UNAUTHENTICATED",
    });
    const bad = token.slice(0, -10) + "AAAAAAAAAA";
    await assert.rejects(auth(`Bearer ${bad}`), { code: "UNAUTHENTICATED" });
    await assert.rejects(auth(), { code: "UNAUTHENTICATED" });
  } finally {
    for (const k of [
      "HARNESS_MODE",
      "UCS_JWKS_URL",
      "UCS_ISSUER",
      "UCS_AUDIENCE",
    ])
      delete process.env[k];
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    setDefaultCACertificates(old);
  }
});
