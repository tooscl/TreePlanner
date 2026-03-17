import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "store.json");
const port = Number(process.env.PORT || 3000);

const defaultState = {
  projects: [],
  tags: [],
  tasks: []
};

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function normalizeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  return {
    projects: Array.isArray(state.projects) ? state.projects : [],
    tags: Array.isArray(state.tags) ? state.tags : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : []
  };
}

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify(defaultState, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(dataFile, "utf8");
  return normalizeState(JSON.parse(raw));
}

async function writeStore(state) {
  await ensureStore();
  const normalized = normalizeState(state);
  const tempFile = `${dataFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(normalized, null, 2));
  await fs.rename(tempFile, dataFile);
  return normalized;
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(payload);
}

async function serveStatic(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      await serveStatic(path.join(safePath, "index.html"), response);
      return;
    }

    const ext = path.extname(filePath);
    const contentType = contentTypes[ext] || "application/octet-stream";
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType
    });
    response.end(file);
  } catch {
    sendText(response, 404, "Not Found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/state" && request.method === "GET") {
      const state = await readStore();
      sendJson(response, 200, state);
      return;
    }

    if (url.pathname === "/api/state" && request.method === "POST") {
      const body = await readBody(request);
      const state = await writeStore(body);
      sendJson(response, 200, state);
      return;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        ok: true,
        dataFile
      });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    sendText(response, 405, "Method Not Allowed");
  } catch (error) {
    sendJson(response, 500, {
      error: "Server error",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, () => {
  console.log(`PlannerApp is running on http://localhost:${port}`);
  console.log(`Data file: ${dataFile}`);
});
