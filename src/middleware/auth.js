const jwt = require("jsonwebtoken");
const { supabase } = require("../config/supabase");

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided. Please log in." });
  }
  try {
    const token = authHeader.split(" ")[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Revocation check: a password reset bumps users.token_version, killing
    // every token signed before it. Tokens from before this field existed
    // carry no tv and are treated as version 0.
    const { data: u, error } = await supabase.from("users").select("token_version").eq("id", payload.id).single();
    if (error || !u) return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
    if ((payload.tv ?? 0) !== (u.token_version ?? 0)) {
      return res.status(401).json({ error: "Session expired — please log in again." });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};
