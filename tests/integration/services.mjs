import http from "node:http";
import { writeFileSync } from "node:fs";

http.createServer((request, response) => {
  response.setHeader("content-type", "text/plain");
  if (request.url === "/stream") {
    response.write("STREAM_READY\n");
    const interval = setInterval(() => response.write("tick\n"), 1000);
    response.on("close", () => clearInterval(interval));
    return;
  }
  response.end("ORBITAL_WEBSITE_FIXTURE\n");
}).listen(3000, "0.0.0.0");

http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const result = { marker: "ORBITAL_WEBHOOK_FIXTURE", method: request.method, url: request.url,
      header: request.headers["x-orbital-fixture"], body: Buffer.concat(chunks).toString("base64") };
    writeFileSync("webhook.json", JSON.stringify(result));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
}).listen(4000, "0.0.0.0", () => console.log("SERVICES_STARTED"));
