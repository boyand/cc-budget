'use strict';

function isPeak(peakConfig) {
  if (!peakConfig) return false;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: peakConfig.timezone,
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date()).map(p => [p.type, p.value])
    );
    const hour = parseInt(parts.hour, 10);
    const isWeekday = !['Sat', 'Sun'].includes(parts.weekday);
    if (peakConfig.weekdays_only && !isWeekday) return false;
    return hour >= peakConfig.start_hour && hour < peakConfig.end_hour;
  } catch (e) {
    return false;
  }
}

module.exports = { isPeak };
