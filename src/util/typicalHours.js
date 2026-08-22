// hour_data (BestTime day_raw) is 6am-anchored LOCAL time: index 0 = 6:00am on
// day_int's day, index 23 = 5:00am the NEXT day. Server clock is UTC on Railway.
// Shared by the venue routes and the crowd-baseline rollup job — both sides
// must agree on this convention or charts shift by hours.
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../config/timezones");

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function baselinePosition(city, now) {
  const tz = CITY_TIMEZONES[city] || DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const localHour = Number(parts.find(p => p.type === "hour").value);
  let dayInt = WEEKDAYS.indexOf(parts.find(p => p.type === "weekday").value);
  let hourIndex;
  if (localHour >= 6) {
    hourIndex = localHour - 6;
  } else {
    // 0:00-5:59am belongs to the previous day's array
    hourIndex = localHour + 18;
    dayInt = (dayInt + 6) % 7;
  }
  return { dayInt, hourIndex, localHour };
}

module.exports = { baselinePosition, WEEKDAYS };
