import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestServer {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startTestServer(port = 0): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || "/", `http://localhost`);
      const pathname = parsedUrl.pathname === "/" ? "/calibration.html" : parsedUrl.pathname;
      const filePath = path.join(__dirname, pathname);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType =
          ext === ".html"
            ? "text/html"
            : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
            ? "text/css"
            : "text/plain";

        res.writeHead(200, { "Content-Type": contentType });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        url,
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          }),
      });
    });

    server.on("error", reject);
  });
}
