import type { BenchmarkOp } from "../lib/layers.js";

export const netFamily: BenchmarkOp[] = [
	{
		family: "net",
		name: "udp_echo_small",
		nativeOp: "udp_echo",
		fileLine: "crates/sidecar/src/execution.rs:2712",
		reproducer: "node:dgram udp4 socket sends hello to its own loopback address inside VM",
		program: `async () => {
  const dgram = await import("node:dgram");
  const createSocket = dgram.createSocket ?? dgram.default?.createSocket;
  if (typeof createSocket !== "function") throw new Error("dgram.createSocket is not a function");
  await new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.on("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.on("message", (message) => {
      socket.close(() => message.toString("utf8") === "hello" ? resolve() : reject(new Error("bad udp echo")));
    });
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.send(Buffer.from("hello"), address.port, "127.0.0.1");
    });
  });
}`,
	},
	{
		family: "net",
		name: "unix_echo_small",
		nativeOp: "tcp_echo",
		fileLine: "crates/sidecar/src/execution.rs:2237",
		reproducer: "Unix-domain socket echo one small payload inside VM",
		program: `async () => {
  const fs = await import("node:fs");
  const net = await import("node:net");
  const os = await import("node:os");
  const path = await import("node:path");
  const sock = path.join(
    os.tmpdir(),
    "fuzz-perf-unix-echo-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".sock",
  );
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.on("data", (data) => socket.end(data)));
    const cleanup = () => {
      try { fs.unlinkSync(sock); } catch {}
    };
    server.on("error", (error) => {
      cleanup();
      reject(error);
    });
    server.listen(sock, () => {
      const client = net.connect(sock);
      const chunks = [];
      client.on("data", (data) => chunks.push(data));
      client.on("error", reject);
      client.on("close", () => {
        const got = Buffer.concat(chunks).toString("utf8");
        server.close(() => {
          cleanup();
          got === "hello" ? resolve() : reject(new Error("bad unix echo"));
        });
      });
      client.write("hello");
    });
  });
}`,
	},
	{
		family: "net",
		name: "http_loopback_get",
		nativeOp: "tcp_echo",
		fileLine: "crates/execution/src/node_import_cache.rs:4750",
		reproducer: "node:http loopback GET inside VM",
		program: `async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          server.close(() => body === "ok" ? resolve() : reject(new Error("bad http body")));
        });
      }).on("error", (error) => {
        server.close(() => reject(error));
      });
    });
  });
}`,
	},
	{
		family: "net",
		name: "fetch_loopback_get",
		nativeOp: "tcp_echo",
		fileLine: "crates/execution/src/node_import_cache.rs:4750",
		reproducer: "global fetch loopback GET inside VM",
		program: `async () => {
  if (typeof fetch !== "function") throw new Error("fetch is not defined");
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const port = server.address().port;
        const res = await fetch("http://127.0.0.1:" + port + "/");
        const body = await res.text();
        server.close(() => body === "ok" ? resolve() : reject(new Error("bad fetch body")));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}`,
	},
	{
		family: "net",
		name: "tcp_connect_close",
		nativeOp: "tcp_connect",
		fileLine: "crates/kernel/src/socket_table.rs:382",
		reproducer: "node net.createServer(); net.connect(port).end() inside VM",
		program: `async () => {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("close", () => server.close(resolve));
      socket.end();
    });
  });
}`,
	},
	{
		family: "net",
		name: "tcp_echo",
		nativeOp: "tcp_echo",
		fileLine: "crates/kernel/src/socket_table.rs:1413",
		reproducer: "localhost TCP echo one small payload inside VM",
		program: `async () => {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.on("data", (d) => socket.end(d)));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const socket = net.connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (d) => data += d.toString("utf8"));
      socket.on("error", reject);
      socket.on("close", () => {
        server.close(() => data === "hello" ? resolve() : reject(new Error(data)));
      });
      socket.write("hello");
    });
  });
}`,
	},
	{
		family: "net",
		name: "tcp_concurrent_4",
		nativeOp: "tcp_concurrent",
		fileLine: "crates/kernel/src/socket_table.rs:382",
		reproducer: "four concurrent localhost TCP clients connect to one VM server",
		program: `async () => {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    let accepted = 0;
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end());
      if (++accepted === 4) server.close(resolve);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      for (let i = 0; i < 4; i++) {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", reject);
        socket.write("x");
      }
    });
  });
}`,
	},
	{
		family: "net",
		name: "tcp_throughput_64k",
		nativeOp: "tcp_throughput",
		fileLine: "crates/kernel/src/socket_table.rs:1413",
		reproducer: "localhost TCP echo of one 64KiB payload inside VM",
		program: `async () => {
  const net = await import("node:net");
  const payload = Buffer.alloc(64 * 1024, 7);
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.on("data", (d) => socket.end(d)));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const socket = net.connect(port, "127.0.0.1");
      const chunks = [];
      socket.on("data", (d) => chunks.push(d));
      socket.on("error", reject);
      socket.on("close", () => {
        const got = Buffer.concat(chunks);
        server.close(() => got.length === payload.length ? resolve() : reject(new Error("short echo")));
      });
      socket.write(payload);
    });
  });
}`,
	},
	{
		family: "net",
		name: "tcp_tiny_writes_16",
		nativeOp: "tcp_tiny_writes",
		fileLine: "crates/kernel/src/socket_table.rs:1335",
		reproducer: "localhost TCP echo using sixteen one-byte writes inside VM",
		program: `async () => {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const chunks = [];
      socket.on("data", (d) => {
        chunks.push(d);
        if (Buffer.concat(chunks).length >= 16) socket.end(Buffer.concat(chunks));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const socket = net.connect(port, "127.0.0.1");
      const chunks = [];
      socket.on("data", (d) => chunks.push(d));
      socket.on("error", reject);
      socket.on("close", () => {
        const got = Buffer.concat(chunks);
        server.close(() => got.length === 16 ? resolve() : reject(new Error("short tiny echo")));
      });
      for (let i = 0; i < 16; i++) socket.write("x");
    });
  });
}`,
	},
];
