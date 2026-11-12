
const express = require("express");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const MAX_SIZE = 5 * 1024 * 1024;
const TIMEOUT = 15000;

// 接続を許可するドメインをRenderの環境変数で指定
// 例: example.com,my-test-site.com
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "example.com")
  .split(",")
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

function isAllowed(host) {
  host = host.toLowerCase();

  return ALLOWED_HOSTS.some(domain =>
    host === domain || host.endsWith("." + domain)
  );
}

function validateUrl(value) {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("HTTPS only");
  }

  if (!isAllowed(url.hostname)) {
    throw new Error("Domain not allowed");
  }

  if (url.username || url.password) {
    throw new Error("Credentials in URL are not allowed");
  }

  return url;
}

// Health Check
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "Lucel Fetch API",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// Fetch API: 許可されたテストサイト専用
app.get("/fetch", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({
        success: false,
        error: "URL parameter is required"
      });
    }

    let url = validateUrl(req.query.url);
    let response;

    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        TIMEOUT
      );

      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "Lucel-Fetch/1.0",
            "Accept": "text/html,application/json,text/plain"
          }
        });
      } finally {
        clearTimeout(timer);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          throw new Error("Redirect without location");
        }

        url = validateUrl(new URL(location, url).href);
        continue;
      }

      break;
    }

    if (!response || [301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error("Too many redirects");
    }

    const contentType =
      response.headers.get("content-type") || "unknown";

    if (
      !/^(text\/html|application\/json|text\/plain)(;|$)/i
        .test(contentType)
    ) {
      return res.status(415).json({
        success: false,
        error: "Unsupported content type",
        contentType
      });
    }

    const declaredSize = Number(
      response.headers.get("content-length") || 0
    );

    if (declaredSize > MAX_SIZE) {
      return res.status(413).json({
        success: false,
        error: "Response too large",
        maxBytes: MAX_SIZE
      });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.byteLength;

      if (totalSize > MAX_SIZE) {
        await reader.cancel();

        return res.status(413).json({
          success: false,
          error: "Response exceeded size limit",
          maxBytes: MAX_SIZE
        });
      }

      chunks.push(value);
    }

    const merged = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const body = new TextDecoder("utf-8").decode(merged);

    res.json({
      success: response.ok,
      status: response.status,
      contentType,
      responseBytes: totalSize,
      responseMB: (totalSize / 1048576).toFixed(2),
      finalUrl: url.href,
      body
    });

  } catch (error) {
    const timeout = error.name === "AbortError";

    res.status(timeout ? 504 : 502).json({
      success: false,
      error: timeout
        ? "Request timeout"
        : error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lucel Fetch API running on port ${PORT}`);
});
