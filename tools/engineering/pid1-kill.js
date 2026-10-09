"use strict";
// 仅容器故障注入：命名空间 PID 1 的自发 SIGKILL 不可靠，交由宿主 Docker 强杀。
const fs = require("node:fs"), nativeKill = process.kill.bind(process);
process.kill = function(pid, signal) {
  if (pid === process.pid && pid === 1 && signal === "SIGKILL") {
    const fd = fs.openSync("/tmp/phase2-kill-ready", "w", 0o644);
    fs.writeSync(fd, "ready\n"); fs.fsyncSync(fd); fs.closeSync(fd);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw new Error("test host did not deliver external SIGKILL");
  }
  return nativeKill(pid, signal);
};
