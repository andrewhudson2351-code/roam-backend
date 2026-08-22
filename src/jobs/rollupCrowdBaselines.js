// Rolls consumer crowd reports into Roam's own typical-hours curves
// (venue_crowd_baselines). Per venue × weekday × hour slot (6am-anchored,
// venue-local — the venue_typical_hours convention), take the median busy_level
// of reports from the last LOOKBACK_DAYS. Slots blend into BestTime on a
// linear ramp:
//   n < MIN_REPORTS           → BestTime value unchanged
//   MIN_REPORTS..FULL_REPORTS → weighted blend, weight ramping up with n
//   n ≥ FULL_REPORTS          → our median entirely
// A venue×day row is written only when at least one slot reaches MIN_REPORTS,
// so the table stays sparse and everything else falls back to BestTime.
// Idempotent — recomputes from raw crowd_reports every run.
const { supabase } = require("../config/supabase");
const { baselinePosition } = require("../util/typicalHours");

const MIN_REPORTS = 5;
const FULL_REPORTS = 15;
const LOOKBACK_DAYS = 180;

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function rollupCrowdBaselines() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const reports = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("crowd_reports")
      .select("venue_id, busy_level, reported_at, venues(city)")
      .gte("reported_at", since)
      .order("reported_at", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    reports.push(...data);
    if (data.length < 1000) break;
  }

  // slots.get(venue_id)[day_int][hour_index] = [busy_level, ...]
  const slots = new Map();
  for (const r of reports) {
    if (!r.venue_id || typeof r.busy_level !== "number") continue;
    const { dayInt, hourIndex } = baselinePosition(r.venues?.city, new Date(r.reported_at));
    if (!slots.has(r.venue_id)) slots.set(r.venue_id, Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => [])));
    slots.get(r.venue_id)[dayInt][hourIndex].push(r.busy_level);
  }

  const qualifyingVenues = [...slots.keys()].filter((vid) =>
    slots.get(vid).some((day) => day.some((slot) => slot.length >= MIN_REPORTS))
  );
  if (!qualifyingVenues.length) return 0;

  const { data: btRows, error: btErr } = await supabase
    .from("venue_typical_hours")
    .select("venue_id, day_int, hour_data")
    .in("venue_id", qualifyingVenues);
  if (btErr) throw btErr;
  const bt = new Map((btRows || []).map((r) => [`${r.venue_id}:${r.day_int}`, r.hour_data]));

  const upserts = [];
  for (const vid of qualifyingVenues) {
    for (let day = 0; day < 7; day++) {
      const daySlots = slots.get(vid)[day];
      if (!daySlots.some((slot) => slot.length >= MIN_REPORTS)) continue;
      const btDay = bt.get(`${vid}:${day}`);
      const hourData = daySlots.map((slot, i) => {
        const base = Array.isArray(btDay) ? Math.round(Number(btDay[i]) || 0) : 0;
        if (slot.length < MIN_REPORTS) return base;
        const weight = Math.min(1, (slot.length - MIN_REPORTS + 1) / (FULL_REPORTS - MIN_REPORTS + 1));
        return Math.round(weight * median(slot) + (1 - weight) * base);
      });
      upserts.push({
        venue_id: vid,
        day_int: day,
        hour_data: hourData,
        sample_counts: daySlots.map((slot) => slot.length),
        updated_at: new Date().toISOString(),
      });
    }
  }

  const { error: upErr } = await supabase
    .from("venue_crowd_baselines")
    .upsert(upserts, { onConflict: "venue_id,day_int" });
  if (upErr) throw upErr;
  return upserts.length;
}

module.exports = rollupCrowdBaselines;
