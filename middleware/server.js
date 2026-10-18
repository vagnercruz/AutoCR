import express from "express";

const username = process.env.RA_USERNAME;
const password = process.env.RA_PASSWORD;

if (!username || !password) {
  throw new Error("RA_USERNAME and RA_PASSWORD must be set. See middleware/.env.example.");
}

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

async function doRequest(query) {
  const params = new URLSearchParams(query);
  const res = await fetch(`https://retroachievements.org/dorequest.php?${params.toString()}`, {
    headers: { "User-Agent": "authorblues-tools/1.0" },
  });
  const body = await res.json();
  return body;
}

// RA tokens stay valid for a long time, so reuse one instead of logging in on every request.
// Warm serverless instances keep module state, so this also helps on Vercel.
const TOKEN_TTL_MS = 30 * 60 * 1000;
let cachedToken = null; // { promise, expires }

async function login() {
  const data = await doRequest({ r: "login2", u: username, p: password });
  if (!data.Token) {
    throw new Error(`Login failed: ${data.Error ?? "no token returned"}`);
  }
  return data.Token;
}

function getToken() {
  if (!cachedToken || cachedToken.expires < Date.now()) {
    const promise = login();
    cachedToken = { promise, expires: Date.now() + TOKEN_TTL_MS };
    // don't keep a failed login around
    promise.catch(() => {
      if (cachedToken?.promise === promise) {
        cachedToken = null;
      }
    });
  }
  return cachedToken.promise;
}

// Runs an authenticated request, logging in again once if the cached token was rejected.
async function withToken(fn) {
  const data = await fn(await getToken());
  if (data?.Success !== false) {
    return data;
  }
  cachedToken = null;
  return fn(await getToken());
}

function parseGameId(req, res) {
  const gameid = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(gameid) || gameid <= 0) {
    res.status(400).send("Invalid game id");
    return null;
  }
  return gameid;
}

const getAchievementSets = (gameid) =>
  withToken((t) => doRequest({ r: "achievementsets", u: username, t, g: gameid }));
const getCodeNotes = async (gameid) =>
  (await withToken((t) => doRequest({ r: "codenotes2", t, g: gameid }))).CodeNotes;

app.get("/game/:id", async (req, res) => {
  const gameid = parseGameId(req, res);
  if (gameid === null) {
    return;
  }
  try {
    console.log(`[request] game ${gameid}`);
    res.send(await getAchievementSets(gameid));
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching achievements");
  }
});

app.get("/notes/:id", async (req, res) => {
  const gameid = parseGameId(req, res);
  if (gameid === null) {
    return;
  }
  try {
    console.log(`[request] notes ${gameid}`);
    res.send(await getCodeNotes(gameid));
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching code notes");
  }
});

app.get("/pack/:id", async (req, res) => {
  const gameid = parseGameId(req, res);
  if (gameid === null) {
    return;
  }
  try {
    console.log(`[request] pack ${gameid}`);
    const [game, notes] = await Promise.all([getAchievementSets(gameid), getCodeNotes(gameid)]);
    res.send({ game, notes });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching data pack");
  }
});

app.get("/", (req, res) => {
  res.send("Hello RetroAchievements!");
});

export default app;
