// POST /api/rate handler. Runs as a Vercel serverless function, and is
// also used by server.js for the local web interface.

const fs = require("fs");
const path = require("path");
const { rateModel, rateAnswers, loadTests, DEFAULT_JUDGE } = require("../rate");

function readBody(request) {
  // On Vercel the body is already read and parsed before the handler runs.
  if (request.body !== undefined) {
    return Promise.resolve(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
  }
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

// Streams one JSON object per line: a "result" per finished test, then "done".
async function handleRate(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    response.end("Method not allowed");
    return;
  }

  let input;
  try {
    input = JSON.parse(await readBody(request));
  } catch {
    input = {};
  }
  const model = String(input.model || "").trim();
  const judge = String(input.judge || "").trim() || process.env.JUDGE_MODEL || DEFAULT_JUDGE;
  // With items, the judge grades the given question/answer pairs directly.
  const items = Array.isArray(input.items)
    ? input.items
        .map((item) => ({ question: String(item.question || "").trim(), answer: String(item.answer || "").trim() }))
        .filter((item) => item.question && item.answer)
    : null;

  response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const send = (event) => response.write(JSON.stringify(event) + "\n");
  const onResult = (result) => send({ type: "result", result });

  if (items && items.length === 0) {
    send({ type: "error", message: "Enter at least one question with its answer." });
  } else if (!items && !model) {
    send({ type: "error", message: "Enter a model ID." });
  } else if (!process.env.OPENROUTER_API_KEY) {
    send({ type: "error", message: "Missing OPENROUTER_API_KEY (set it in the .env file, or in the Vercel project settings)." });
  } else {
    try {
      let report;
      if (items) {
        send({ type: "start", judge, total: items.length });
        report = await rateAnswers(judge, items, onResult);
      } else {
        const tests = loadTests("prompts.json");
        send({ type: "start", model, judge, total: tests.length });
        report = await rateModel(model, judge, tests, onResult);
      }
      // Vercel's filesystem is read-only, so the report is only saved locally.
      if (!process.env.VERCEL) {
        fs.writeFileSync(path.join(__dirname, "..", "report.json"), JSON.stringify(report, null, 2));
      }
      send({ type: "done", score: report.score, verdict: report.verdict, failed: report.failed });
    } catch (error) {
      send({ type: "error", message: error.message });
    }
  }
  response.end();
}

module.exports = handleRate;
