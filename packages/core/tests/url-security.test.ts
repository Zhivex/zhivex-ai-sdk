import { describe, expect, it } from "vitest";

import { assertTrustedEndpoint, isPrivateNetworkHostname } from "../src/index.js";

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
});
