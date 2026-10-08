"use strict";
/* 容器状态：只有管理员能列容器、用关联容器作在线依据；DOCKER_SOCK 也支持 tcp://（socket 代理） */
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, mockServer, cfg, waitFor } = require("./helpers");

test("docker info is admin-only; container fallback only for admins", async (t) => {
  const dockerMock = await mockServer((q, s) => {
    if (q.method === "GET" && q.url.startsWith("/containers/json")) {
      s.writeHead(200, { "Content-Type": "application/json" });
      return s.end(JSON.stringify([{ Id: "abc123abc123", Names: ["/emby"], State: "running", Status: "Up 2 hours", Image: "emby/embyserver" }, { Id: "def", Names: ["/secret-db"], State: "exited", Status: "Exited", Image: "postgres" }]));
    }
    s.writeHead(403); s.end();
  });
  const srv = await startServer({ env: { DOCKER_SOCK: "tcp://127.0.0.1:" + dockerMock.port } });
  t.after(async () => { await srv.stop(); await dockerMock.close(); });
  const admin = client(srv.base);
  await admin.post("/api/setup", { name: "admin", password: "admin-pass-1" });
  await admin.post("/api/users", { name: "bob", password: "bob-pass-1" });
  const bob = client(srv.base);
  await bob.post("/api/login", { name: "bob", password: "bob-pass-1" });

  const d = (await admin.get("/api/docker")).json;
  assert.equal(d.available, true);
  assert.deepEqual(d.containers.map((c) => c.name), ["emby", "secret-db"]);
  const nb = await bob.get("/api/docker");
  assert.equal(nb.status, 403);
  assert.deepEqual(nb.json.containers, []);

  const items = [{ id: "c", title: "emby", lan: "", wan: "", container: "emby" }, { id: "s", title: "db", container: "secret-db" }];
  await admin.put("/api/config", { baseVersion: 0, data: cfg("a", items) });
  await bob.put("/api/config", { baseVersion: 0, data: cfg("b", items) });
  const as = await waitFor(async () => { const r = (await admin.get("/api/status")).json; return r.c ? r : null; });
  assert.equal(as.c.via, "docker"); assert.equal(as.c.up, true); assert.equal(as.s.up, false);
  const bs = (await bob.get("/api/status")).json;
  assert.equal(bs.c, undefined, "non-admin cannot learn container state by naming it");
  assert.equal(bs.s, undefined);
  assert.ok(dockerMock.hits.every((h) => h.startsWith("/containers/json")), "only GET /containers/json is used");
});
