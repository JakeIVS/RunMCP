import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
createServer(async (request, response) => {
  const path = request.url === "/" ? "index.html" : request.url?.replace(/^\//, "") || "index.html";
  try { const body = await readFile(join("src", path)); response.writeHead(200, { "content-type": types[extname(path)] || "text/plain" }); response.end(body); }
  catch { response.writeHead(404).end("Not found"); }
}).listen(4173, "127.0.0.1", () => console.log("RunMCP landing page: http://127.0.0.1:4173"));
