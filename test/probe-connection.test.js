"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, client, mockServer, cfg, waitFor } = require("./helpers");
const { version } = require("../package.json");

const fixture = {
  blocked: { hostname: "r01-blocked.nocturne-regression", address: "203.0.113.15" },
  reachable: { hostname: "r01-reachable.nocturne-regression", address: "127.0.0.1" },
};
const cases = [
  { name: "hostname", host: fixture.blocked.hostname },
  { name: "literal address", host: fixture.blocked.address },
  { name: "hostname with family selection disabled", host: fixture.blocked.hostname, scalar: true },
];

async function completedStatus(c, srv, id) {
  const status = await waitFor(async () => {
    if (srv.child.exitCode !== null || srv.child.signalCode !== null) return { exited: true };
    try {
      const r = await c.get("/api/status");
      assert.equal(r.status, 200);
      return r.json?.[id]?.checkedAt ? r.json : null;
    } catch (error) {
      if (error.cause?.code === "ECONNREFUSED" || error.cause?.code === "ECONNRESET") return null;
      throw error;
    }
  }, 5000);
  assert.equal(srv.child.exitCode, null, "server stays alive after probing " + id + "\n" + srv.log());
  assert.equal(srv.child.signalCode, null, "server has not been terminated");
  assert.ok(status?.[id]?.checkedAt, "probe result completes for " + id + "\n" + srv.log());
  return status;
}

for (const scenario of cases) {
  test("an immediate " + scenario.name + " connection error reports down and preserves service", {
    timeout: 15000,
    skip: Number(process.versions.node.split(".")[0]) < 22 && "outbound BlockList fixture requires Node 22",
  }, async (t) => {
    const requests = [];
    const mock = await mockServer((req, res) => {
      requests.push({ host: req.headers.host, url: req.url, userAgent: req.headers["user-agent"] });
      res.end("owned local target");
    });
    t.after(() => mock.close());
    const srv = await startServer({
      env: {
        NODE_OPTIONS: "--require " + JSON.stringify(path.join(__dirname, "probe-connection-fixture.js")) + (scenario.scalar ? " --no-network-family-autoselection" : ""),
        NOCTURNE_PROBE_TEST_FIXTURE: JSON.stringify(fixture),
        NOCTURNE_NO_AUTH: "1", PROBE_TIMEOUT: "1", PROBE_PRIVATE_ONLY: "0", PROBE_ALLOW: "",
      },
      seed(dataDir) {
        fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "config", "default.json"), JSON.stringify({
          version: 1, updatedAt: new Date().toISOString(), data: { settings: { title: "R01 synthetic probes" }, groups: [] },
          writer: { app: "nocturne", v: version, gen: 2 },
        }));
      },
    });
    t.after(() => srv.stop());
    const c = client(srv.base);
    const initial = await c.get("/api/config");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json.data.groups, []);
    const reachable = { id: "reachable", title: "Owned local target", lan: "http://" + fixture.reachable.hostname + ":" + mock.port + "/r01-control" };
    const putLocal = await c.put("/api/config", { baseVersion: initial.json.version, data: cfg("R01", [reachable]) });
    assert.equal(putLocal.status, 200);
    const localStatus = await completedStatus(c, srv, "reachable");
    assert.equal(localStatus.reachable.status, "up");
    assert.ok(requests.some((request) => request.host === fixture.reachable.hostname + ":" + mock.port && request.url === "/r01-control" && /^Nocturne-StatusProbe\//.test(request.userAgent)), "the real target receives the original Host header");

    const blocked = { id: "connection-error", title: "Node BlockList target", lan: "http://" + scenario.host + "/r01-blocked" };
    const putTarget = await c.put("/api/config", { baseVersion: putLocal.json.version, data: cfg("R01", [reachable, blocked]) });
    assert.equal(putTarget.status, 200);
    const stored = await c.get("/api/config");
    assert.equal(stored.status, 200);
    assert.equal(stored.json.data.groups[0].items[1].lan, blocked.lan);
    const status = await completedStatus(c, srv, "connection-error");
    assert.equal(status["connection-error"].status, "down");
    assert.equal(status["connection-error"].error, "ERR_IP_BLOCKED");
    assert.equal(status.reachable.status, "up");
    const health = await c.get("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.auth, false);
    assert.equal(srv.child.exitCode, null);
  });
}
