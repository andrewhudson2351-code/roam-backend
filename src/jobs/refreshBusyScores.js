const supabase = require("../supabase");

async function refreshBusyScores() {
  const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { data: reports, error } = await supabase
    .from("crowd_reports")
    .select("venue_id, busy_level")
    .gt("reported_at", since);
  if (error) throw error;

  const byVenue = {};
  for (const r of reports) {
    if (!r.venue_id) continue;
    if (!byVenue[r.venue_id]) byVenue[r.venue_id] = [];
    byVenue[r.venue_id].push(r.busy_level);
  }

  const now = new Date().toISOString();
  const scores = Object.entries(byVenue).map(([venue_id, levels]) => ({
    venue_id,
    busy_score: Math.round(levels.reduce((sum, v) => sum + v, 0) / levels.length),
    report_count: levels.length,
    last_updated: now,
  }));

  if (scores.length === 0) return 0;

  const { error: upsertError } = await supabase.from("venue_busy_scores").upsert(scores);
  if (upsertError) throw upsertError;

  const history = scores.map(s => ({ venue_id: s.venue_id, busy_score: s.busy_score, recorded_at: now }));
  const { error: historyError } = await supabase.from("busy_score_history").insert(history);
  if (historyError) throw historyError;

  return scores.length;
}

module.exports = refreshBusyScores;
