import { describe, expect, it } from "vitest";
import { insecureHubWarning } from "./Settings";

describe("insecureHubWarning", () => {
  it("is quiet for empty, https and loopback", () => {
    expect(insecureHubWarning("", { protocol: "https:", host: "deck.example" })).toBeNull();
    expect(insecureHubWarning("")).toBeNull();
    expect(insecureHubWarning("https://hub.example")).toBeNull();
    expect(insecureHubWarning("wss://hub.example")).toBeNull();
    expect(insecureHubWarning("http://localhost:8787")).toBeNull();
    expect(insecureHubWarning("http://127.0.0.1:8787")).toBeNull();
  });
  it("warns for plain http on a LAN host and for an invalid URL", () => {
    expect(insecureHubWarning("http://192.168.1.5:8787")).toMatch(/not encrypted/);
    expect(insecureHubWarning("ws://hub.lan")).toMatch(/not encrypted/);
    expect(insecureHubWarning("", { protocol: "http:", host: "192.168.1.5:5173" })).toMatch(
      /not encrypted/,
    );
    expect(insecureHubWarning("hub.local:8787")).toMatch(/not valid/);
  });
});
