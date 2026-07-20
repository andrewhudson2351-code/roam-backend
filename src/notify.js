// Fire-and-forget push helper. Never throws — callers should not await it in a
// way that blocks the response. Cleans up dead device tokens as it goes.
const { supabase } = require("./config/supabase");
const { sendPush } = require("./config/apns");

async function notifyUser(userId, { title, body, data }) {
  try {
    const { data: tokens } = await supabase.from("device_tokens").select("token").eq("user_id", userId);
    if (!tokens?.length) return;
    for (const { token } of tokens) {
      const res = await sendPush(token, { title, body, data });
      if (res.unregistered) await supabase.from("device_tokens").delete().eq("token", token);
    }
  } catch (err) {
    console.error("notifyUser error:", err.message);
  }
}

module.exports = { notifyUser };
