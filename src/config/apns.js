// APNs (Apple Push Notification service) sender over HTTP/2 with a provider
// token — no third-party library, just Node's http2 + a JWT signed with the
// .p8 auth key. Fail-soft: if the env vars aren't set yet, sendPush no-ops so
// the app runs fine until push is configured.
//
// Env (set in Railway once the APNs key exists):
//   APNS_KEY      contents of the AuthKey_XXXX.p8 file (PEM, multi-line)
//   APNS_KEY_ID   the 10-char Key ID from the Apple Developer key
//   APNS_TEAM_ID  the 10-char Apple Developer Team ID
//   APNS_BUNDLE_ID app bundle id (default app.roaman)
//   APNS_HOST     override host (default production: https://api.push.apple.com)

const http2 = require("http2");
const jwt = require("jsonwebtoken");

const APNS_KEY = (process.env.APNS_KEY || "").replace(/\\n/g, "\n");
const { APNS_KEY_ID, APNS_TEAM_ID } = process.env;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || "app.roaman";
const APNS_HOST = process.env.APNS_HOST || "https://api.push.apple.com";
const configured = !!(APNS_KEY && APNS_KEY_ID && APNS_TEAM_ID);

if (!configured) console.warn("[apns] push disabled — set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID to enable");

let cachedToken = null, cachedAt = 0;
function providerToken() {
  // APNs provider tokens live up to 1h; refresh every ~55 min.
  if (cachedToken && Date.now() - cachedAt < 55 * 60 * 1000) return cachedToken;
  cachedToken = jwt.sign({}, APNS_KEY, { algorithm: "ES256", keyid: APNS_KEY_ID, issuer: APNS_TEAM_ID, expiresIn: "1h" });
  cachedAt = Date.now();
  return cachedToken;
}

// Resolves { ok } or { ok:false, status, reason, unregistered } — never rejects.
// unregistered=true means the token is dead and the caller should delete it.
function sendPush(deviceToken, { title, body, data = {} }) {
  return new Promise((resolve) => {
    if (!configured) return resolve({ ok: false, reason: "not_configured" });
    let client;
    try { client = http2.connect(APNS_HOST); }
    catch (e) { return resolve({ ok: false, reason: e.message }); }
    client.on("error", () => { try { client.close(); } catch {} resolve({ ok: false, reason: "connect_error" }); });
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, ...data });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    let status = 0, respBody = "";
    req.on("response", (h) => { status = h[":status"]; });
    req.on("data", (d) => (respBody += d));
    req.on("end", () => {
      try { client.close(); } catch {}
      if (status === 200) return resolve({ ok: true });
      let reason = respBody;
      try { reason = JSON.parse(respBody).reason; } catch {}
      const unregistered = status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
      resolve({ ok: false, status, reason, unregistered });
    });
    req.on("error", () => { try { client.close(); } catch {} resolve({ ok: false, reason: "request_error" }); });
    req.end(payload);
  });
}

module.exports = { sendPush, apnsConfigured: configured };
