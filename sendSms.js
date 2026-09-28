/**
 * EduTrack CBC — SMS-to-parents backend for Vercel (no Firebase Blaze plan needed).
 * Same contract as the Firebase version:
 *   { test:true, recipients:[{phone,message}] }        -> send, no credit change
 *   { schoolCode, recipients:[{phone,message}] }       -> check credit, send, deduct, return newBalance
 * Response: { ok:true, sent, failed, failedNumbers, creditsUsed, newBalance } | { ok:false, error }
 *
 * Secrets come from Vercel Environment Variables, never from files in the repo.
 */
const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL:
        process.env.FIREBASE_DATABASE_URL ||
        "https://markbook-45fc1-default-rtdb.firebaseio.com",
    });
  }
  return admin.database();
}

const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY = process.env.AT_API_KEY;
const AT_ENDPOINT =
  AT_USERNAME === "sandbox"
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

// 1 credit = 1 segment (<=153 chars), same as smsSegments() in index.html
function segments(text) {
  return Math.max(1, Math.ceil((text || "").length / 153));
}

async function sendGroup(numbers, message) {
  const body = new URLSearchParams({ username: AT_USERNAME, to: numbers.join(","), message });
  const r = await fetch(AT_ENDPOINT, {
    method: "POST",
    headers: {
      apiKey: AT_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await r.json().catch(() => ({}));
  const results = {};
  const recips = (data.SMSMessageData && data.SMSMessageData.Recipients) || [];
  recips.forEach((x) => {
    results[x.number] = { ok: x.status === "Success", status: x.status };
  });
  numbers.forEach((n) => {
    if (!results[n]) results[n] = { ok: false, status: "No response from carrier" };
  });
  return results;
}

async function sendAll(recipients) {
  const groups = {};
  recipients.forEach((r) => (groups[r.message] = groups[r.message] || []).push(r.phone));
  let sent = 0, failed = 0, creditsUsed = 0;
  const failedNumbers = [];
  for (const message of Object.keys(groups)) {
    const numbers = groups[message];
    const segs = segments(message);
    const results = await sendGroup(numbers, message);
    numbers.forEach((n) => {
      if (results[n].ok) { sent++; creditsUsed += segs; }
      else { failed++; failedNumbers.push(n); }
    });
  }
  return { sent, failed, failedNumbers, creditsUsed };
}

module.exports = async (req, res) => {
  // CORS — the app is served from a different origin than this function
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  if (!AT_USERNAME || !AT_API_KEY) {
    return res.status(500).json({ ok: false, error: "SMS is not configured on the server yet." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { schoolCode, recipients, test } = body || {};

  if (!Array.isArray(recipients) || recipients.length === 0)
    return res.status(400).json({ ok: false, error: "No recipients supplied" });
  for (const r of recipients) {
    if (!r || !r.phone || !r.message)
      return res.status(400).json({ ok: false, error: "Every recipient needs a phone and a message" });
  }
  if (recipients.length > 2000)
    return res.status(400).json({ ok: false, error: "Too many recipients in one request" });

  try {
    if (test) {
      const result = await sendAll(recipients);
      return res.json({ ok: true, ...result, creditsUsed: 0 });
    }

    if (!schoolCode || typeof schoolCode !== "string" || /[.#$\[\]\/]/.test(schoolCode))
      return res.status(400).json({ ok: false, error: "A valid schoolCode is required" });

    const db = getDb();
    const snap = await db.ref("schools/" + schoolCode + "/data").once("value");
    const school = snap.val();
    if (!school) return res.status(404).json({ ok: false, error: "Unknown school code" });

    const needed = recipients.reduce((n, r) => n + segments(r.message), 0);
    const balance = school.smsCredits || 0;
    if (needed > balance)
      return res.status(400).json({ ok: false, error: `Not enough credit: need ${needed}, have ${balance}` });

    const result = await sendAll(recipients);

    const tx = await db
      .ref("schools/" + schoolCode + "/data/smsCredits")
      .transaction((cur) => (cur || 0) - result.creditsUsed);
    const newBalance = tx.committed ? tx.snapshot.val() : balance - result.creditsUsed;

    return res.json({ ok: true, ...result, newBalance });
  } catch (err) {
    console.error("sendSms failed", err);
    return res.status(500).json({ ok: false, error: "Server error: " + (err.message || err) });
  }
};
