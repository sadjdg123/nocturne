"use strict";

const dns = require("node:dns");
const http = require("node:http");
const net = require("node:net");
if (process.env.NOCTURNE_PROBE_TEST_FIXTURE) {
  const fixture = JSON.parse(process.env.NOCTURNE_PROBE_TEST_FIXTURE);

  const blockList = new net.BlockList();
  blockList.addAddress(fixture.blocked.address, "ipv4");
  http.globalAgent = new http.Agent({ blockList, keepAlive: false });

  const originalLookup = dns.promises.lookup;
  const addresses = new Map(Object.values(fixture).map((target) => [target.hostname, target.address]));
  dns.promises.lookup = async function (hostname, ...args) {
    if (!addresses.has(hostname)) return Reflect.apply(originalLookup, this, [hostname, ...args]);
    const entry = { address: addresses.get(hostname), family: 4 };
    return args[0]?.all ? [entry] : entry;
  };
}
