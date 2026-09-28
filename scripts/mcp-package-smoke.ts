import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run after build. Exercise installed candidate tarballs, never workspace aliases.
const root = resolve(import.meta.dirname, "..");
const consumer = mkdtempSync(join(tmpdir(), "zhivex-mcp-smoke-"));
try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dependencies: Record<string, string> = {
    "@modelcontextprotocol/sdk": manifest.devDependencies["@modelcontextprotocol/sdk"],
    zod: manifest.devDependencies.zod.replace(/^[~^]/, "")
  };
  for (const name of ["core", "sdk"]) {
    const directory = join(root, "packages", name);
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const tarball = join(consumer, `${name}.tgz`);
    execFileSync("bun", ["pm", "pack", "--filename", tarball, "--ignore-scripts"], { cwd: directory, stdio: "pipe" });
    dependencies[pkg.name] = `file:${tarball}`;
  }
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "mcp-consumer-smoke", private: true, type: "module", dependencies,
    overrides: { "@zhivex-ai/core": dependencies["@zhivex-ai/core"] }
  }, null, 2));
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "pipe" });
  // A private one-day test CA: verification remains enabled in both runtimes.
  const certificate = join(consumer, "cert.pem");
  const key = join(consumer, "key.pem");
  const config = join(consumer, "openssl.cnf");
  writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=MCP loopback fixture\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", key, "-out", certificate], { stdio: "pipe" });
  const fixture = "mcp-http-consumer.mjs";
  writeFileSync(join(consumer, fixture), readFileSync(join(root, "scripts/fixtures", fixture)));
  for (const runtime of ["node", "bun"]) {
    console.log(`Certifying installed MCP with ${runtime} and official SDK ${dependencies["@modelcontextprotocol/sdk"]}...`);
    execFileSync(runtime, [fixture], {
      cwd: consumer, stdio: "inherit", timeout: 90_000,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, MCP_TEST_CERT: certificate, MCP_TEST_KEY: key }
    });
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
