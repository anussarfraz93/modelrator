// Rate an OpenRouter model: run test prompts, have a judge model grade each
// answer, then print a 0-100 score and a GOOD / OK / BAD verdict.
//
// Usage: node rate.js <model-id> [--judge <model-id>] [--prompts <file>]

const fs = require("fs");
const path = require("path");

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_JUDGE = "typesafe/jev-router";
const GOOD_SCORE = 75;
const BAD_SCORE = 50;

function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function parseArgs(argv) {
  const args = { model: null, judge: null, prompts: "prompts.json" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--judge") args.judge = argv[++i];
    else if (argv[i] === "--prompts") args.prompts = argv[++i];
    else if (!args.model) args.model = argv[i];
  }
  return args;
}

async function chat(model, messages, temperature) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 1000 }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = data.error?.message || response.statusText;
    throw new Error(`${model}: ${response.status} ${message}`);
  }
  return data.choices?.[0]?.message?.content ?? "";
}

async function judgeAnswer(judge, test, answer) {
  const instructions =
    "You are a strict grader of answers. Grade the answer to the question " +
    "for correctness, following instructions, and clarity, using the " +
    "expected answer when one is given. Reply with ONLY a JSON object: " +
    '{"score": <integer 0-10>, "reason": "<one short sentence>"}';
  const content =
    `Question:\n${test.prompt}\n\n` +
    (test.expected ? `Expected answer:\n${test.expected}\n\n` : "") +
    `Answer to grade:\n${answer || "(empty answer)"}`;

  const reply = await chat(
    judge,
    [
      { role: "system", content: instructions },
      { role: "user", content },
    ],
    0
  );
  const json = reply.match(/\{[\s\S]*\}/);
  if (!json) throw new Error(`judge returned no JSON: ${reply.slice(0, 100)}`);
  const result = JSON.parse(json[0]);
  const score = Math.max(0, Math.min(10, Number(result.score)));
  if (Number.isNaN(score)) throw new Error("judge returned no numeric score");
  return { score, reason: String(result.reason || "") };
}

function verdict(score) {
  if (score >= GOOD_SCORE) return "GOOD";
  if (score >= BAD_SCORE) return "OK";
  return "BAD";
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const judge = args.judge || process.env.JUDGE_MODEL || DEFAULT_JUDGE;

  if (!args.model) {
    console.error("Usage: node rate.js <model-id> [--judge <model-id>] [--prompts <file>]");
    console.error("Example: node rate.js meta-llama/llama-3.3-70b-instruct");
    process.exit(1);
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Missing OPENROUTER_API_KEY. Put it in a .env file next to rate.js.");
    process.exit(1);
  }

  const tests = loadTests(args.prompts);
  console.log(`Model: ${args.model}`);
  console.log(`Judge: ${judge}`);
  console.log(`Tests: ${tests.length}\n`);

  const report = await rateModel(args.model, judge, tests);

  for (const result of report.results) {
    const shown = result.score === null ? "ERR  " : `${String(result.score).padStart(2)}/10`;
    console.log(`[${shown}] ${result.category.padEnd(13)} ${result.reason}`);
  }

  if (report.score === null) {
    console.error("\nNo test could be graded, so there is no score.");
    process.exit(1);
  }

  console.log(`\nScore:   ${report.score}/100`);
  console.log(`Verdict: ${report.verdict}`);
  if (report.failed > 0) {
    console.log(`Note: ${report.failed} test(s) failed and were left out of the score.`);
  }

  const reportFile = path.join(__dirname, "report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nFull answers saved to ${path.basename(reportFile)}`);
}

function loadTests(file) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, file), "utf8"));
}

// Runs every test against the model and grades it. onResult is called as
// each test finishes, so a caller can show progress.
async function rateModel(model, judge, tests, onResult = () => {}) {
  const results = await Promise.all(
    tests.map(async (test) => {
      let result;
      try {
        const answer = await chat(model, [{ role: "user", content: test.prompt }], 0.2);
        const grade = await judgeAnswer(judge, test, answer);
        result = { ...test, answer, ...grade };
      } catch (error) {
        result = { ...test, answer: "", score: null, reason: error.message };
      }
      onResult(result);
      return result;
    })
  );

  return { model, judge, ...summarize(results) };
}

// Grades question/answer pairs the caller already has, without calling a
// model to produce the answers. items: [{ question, answer }]
async function rateAnswers(judge, items, onResult = () => {}) {
  const results = await Promise.all(
    items.map(async (item, index) => {
      const test = { category: `Q${index + 1}`, prompt: item.question };
      let result;
      try {
        const grade = await judgeAnswer(judge, test, item.answer);
        result = { ...test, answer: item.answer, ...grade };
      } catch (error) {
        result = { ...test, answer: item.answer, score: null, reason: error.message };
      }
      onResult(result);
      return result;
    })
  );
  return { judge, ...summarize(results) };
}

function summarize(results) {
  const graded = results.filter((result) => result.score !== null);
  const failed = results.length - graded.length;
  if (graded.length === 0) {
    return { score: null, verdict: null, failed, results };
  }
  const total = graded.reduce((sum, result) => sum + result.score, 0);
  const score = Math.round((total / (graded.length * 10)) * 100);
  return { score, verdict: verdict(score), failed, results };
}

module.exports = { rateModel, rateAnswers, loadTests, loadEnvFile, DEFAULT_JUDGE };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
