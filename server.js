// Local web interface for rate.js.
//
// Usage: node server.js   then open http://localhost:3000

const fs = require("fs");
const http = require("http");
const path = require("path");
const { loadEnvFile } = require("./rate");
const handleRate = require("./api/rate");

const PORT = Number(process.env.PORT) || 3000;

loadEnvFile();

const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/rate") {
    handleRate(request, response);
  } else if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(path.join(__dirname, "index.html")));
  } else {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Model Rater running at http://localhost:${PORT}`);
});
