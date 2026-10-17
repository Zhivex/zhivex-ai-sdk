import { describe, expect, it, vi } from "vitest";

import { assertTrustedEndpoint, isLoopbackHostname, isPrivateNetworkHostname, ProviderHTTPError, withManualRedirect } from "../src/index.js";

describe("trusted endpoint validation", () => {
  it("rejects credentials and disallowed protocols", () => {
    expect(() => assertTrustedEndpoint("https://user:secret@example.com", {
      protocols: ["https"]
    })).toThrow("embedded credentials");
    expect(() => assertTrustedEndpoint("http://example.com", {
      protocols: ["https"]
    })).toThrow("must use https");
  });

  it("matches host allowlists on exact DNS label boundaries", () => {
    expect(assertTrustedEndpoint("https://api.example.com/path", {
      protocols: ["https"],
      allowedHostSuffixes: ["example.com"]
    }).hostname).toBe("api.example.com");
    expect(() => assertTrustedEndpoint("https://evilexample.com", {
      protocols: ["https"],
      allowedHostSuffixes: ["example.com"]
    })).toThrow("is not trusted");
  });

  it("rejects loopback and private IPv4 and IPv6 unless explicitly allowed", () => {
    for (const endpoint of [
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://172.16.0.1",
      "https://192.168.0.1",
      "https://[::1]",
      "https://[fc00::1]",
      "https://[fe80::1]",
      "https://[::ffff:172.20.0.1]"
    ]) {
      expect(() => assertTrustedEndpoint(endpoint, { protocols: ["https"] })).toThrow("private");
    }
    expect(assertTrustedEndpoint("http://127.0.0.1:8080", {
      protocols: ["http"],
      allowLoopback: true
    }).hostname).toBe("127.0.0.1");
  });

  it("supports an explicit unsafe endpoint opt-in without allowing userinfo", () => {
    expect(assertTrustedEndpoint("http://10.0.0.1", {
      protocols: ["https"],
      allowUnsafe: true
    }).hostname).toBe("10.0.0.1");
    expect(() => assertTrustedEndpoint("http://user:secret@10.0.0.1", {
      protocols: ["https"],
      allowUnsafe: true
    })).toThrow("embedded credentials");
    expect(() => assertTrustedEndpoint("file:///etc/passwd", {
      protocols: ["https"],
      allowUnsafe: true
    })).toThrow("must use https");
    expect(() => assertTrustedEndpoint("ftp://example.com", {
      protocols: ["https"],
      allowUnsafe: true
    })).toThrow("must use https");
  });

  it("recognizes private IPv4-mapped IPv6 hosts", () => {
    expect(isPrivateNetworkHostname("::ffff:172.16.0.1")).toBe(true);
    expect(isPrivateNetworkHostname("::ffff:172.31.255.255")).toBe(true);
    expect(isPrivateNetworkHostname("::ffff:172.32.0.1")).toBe(false);
    expect(isPrivateNetworkHostname("::ffff:ac10:1")).toBe(true);
    expect(isPrivateNetworkHostname("100.64.0.1")).toBe(true);
  });

  it("rejects DNS aliases that lexically target private addresses", () => {
    for (const endpoint of [
      "https://127.0.0.1.nip.io/v1",
      "https://10.0.0.1.sslip.io/v1",
      "https://localtest.me/v1",
      "https://api.localtest.me/v1"
    ]) {
      expect(() => assertTrustedEndpoint(endpoint, { protocols: ["https"] })).toThrow("private");
    }
    expect(isPrivateNetworkHostname("cdn.203.0.113.5.example.com")).toBe(false);
  });

  it("uses an application host allowlist as the synchronous rebinding boundary", () => {
    expect(assertTrustedEndpoint("https://media.example.com/object", {
      protocols: ["https"],
      allowedHosts: ["media.example.com"]
    }).hostname).toBe("media.example.com");
    expect(() => assertTrustedEndpoint("https://attacker.example.net/object", {
      protocols: ["https"],
      allowedHosts: ["media.example.com"]
    })).toThrow("is not trusted");
  });

  it("blocks alternate IPv4 literals, embedded forms, and cloud metadata hosts", () => {
    for (const endpoint of [
      "https://2130706433",
      "https://0x7f000001",
      "https://0177.0.0.1",
      "https://127.1",
      "https://127.0.1",
      "https://[::7f00:1]",
      "https://[::127.0.0.1]",
      "https://[0:0:0:0:0:0:0:1]",
      "https://[2002:7f00:1::]",
      "https://[64:ff9b::127.0.0.1]",
      "https://[64:ff9b:1::7f00:1]",
      "https://[::ffff:a9fe:a9fe]",
      "https://[fd00:ec2::254]",
      "https://[ff02::1]",
      "https://2130706433.nip.io/latest",
      "https://127.1.nip.io/latest",
      "https://0177.0.0.1.nip.io/latest",
      "https://0x7f.0.0.1.nip.io/latest",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://metadata.goog/",
      "https://169.254.169.254/latest/meta-data/"
    ]) {
      expect(() => assertTrustedEndpoint(endpoint, { protocols: ["https"] }), endpoint).toThrow("private");
    }

    expect(assertTrustedEndpoint("https://8.8.8.8", { protocols: ["https"] }).hostname).toBe("8.8.8.8");
    expect(assertTrustedEndpoint("https://[2001:4860:4860::8888]", { protocols: ["https"] }).hostname).toBe("[2001:4860:4860::8888]");
    expect(assertTrustedEndpoint("https://[::ffff:8.8.8.8]", { protocols: ["https"] }).hostname).toBe("[::ffff:808:808]");
    expect(assertTrustedEndpoint("https://[2002:808:808::]", { protocols: ["https"] }).hostname).toBe("[2002:808:808::]");
    expect(assertTrustedEndpoint("https://[64:ff9b::8.8.8.8]", { protocols: ["https"] }).hostname).toBe("[64:ff9b::808:808]");
    expect(isPrivateNetworkHostname("cdn.203.0.113.5.example.com")).toBe(false);
    expect(isPrivateNetworkHostname("10.example.com")).toBe(false);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.1")).toBe(true);
    expect(isLoopbackHostname("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.nip.io")).toBe(false);
    expect(assertTrustedEndpoint("http://[::1]:11434", {
      protocols: ["http"],
      allowLoopback: true
    }).hostname).toBe("[::1]");
    expect(() => assertTrustedEndpoint("http://127.1.nip.io", {
      protocols: ["http"],
      allowLoopback: true
    })).toThrow("private");
  });
});

describe("credentialed redirect policy", () => {
  it("rejects a redirect once and leaves an explicit redirect policy unchanged", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "manual") {
        return new Response(null, { status: 307, headers: { location: "http://127.0.0.1/private" } });
      }
      return new Response("ok", { status: 200 });
    });
    const guarded = withManualRedirect(fetcher as typeof fetch);

    await expect(guarded("https://api.example.com/v1")).rejects.toBeInstanceOf(ProviderHTTPError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });

    fetcher.mockClear();
    await expect(guarded("https://api.example.com/v1", { redirect: "error" })).resolves.toBeInstanceOf(Response);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });

    fetcher.mockClear();
    const opaque = withManualRedirect((async () => ({ type: "opaqueredirect", status: 0, body: { cancel: async () => undefined } })) as typeof fetch);
    await expect(opaque("https://api.example.com/v1")).rejects.toMatchObject({ status: 302 });
  });
});
