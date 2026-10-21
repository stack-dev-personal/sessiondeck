// Test fixture for the live e2e (R3.9): a TCP forwarder in front of the hub that can cut and
// restore WebSocket links without touching the hub or its ingest port.
//   UPSTREAM=host:port  LISTEN=8787  CONTROL=9000
//   GET /down  drops every open connection and refuses new ones
//   GET /up    forwards again
import http from "node:http";
import net from "node:net";

const [upHost, upPort] = (process.env.UPSTREAM ?? "hub:8787").split(":");
const listen = Number(process.env.LISTEN ?? 8787);
const control = Number(process.env.CONTROL ?? 9000);
let down = false;
const open = new Set();

net
  .createServer((c) => {
    if (down) return c.destroy();
    const u = net.connect(Number(upPort), upHost);
    open.add(c).add(u);
    const end = () => {
      c.destroy();
      u.destroy();
      open.delete(c);
      open.delete(u);
    };
    c.on("error", end).on("close", end);
    u.on("error", end).on("close", end);
    c.pipe(u);
    u.pipe(c);
  })
  .listen(listen, "0.0.0.0");

http
  .createServer((req, res) => {
    if (req.url === "/down") {
      down = true;
      for (const s of open) s.destroy();
    } else if (req.url === "/up") down = false;
    else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(down ? "down" : "up");
  })
  .listen(control, "0.0.0.0");
