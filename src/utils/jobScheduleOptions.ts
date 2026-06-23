export type JobScheduleInterval =
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days'
  | 'fixed';

export type JobScheduleDisplayUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export interface JobScheduleOption {
  totalSeconds: number;
  displayUnit: JobScheduleDisplayUnit;
  displayValue: number;
}

// Curated presets — common intervals used for polling, sync, and maintenance jobs
// (not every second/minute). Labels pick the most natural unit per value.
const SECONDS_PRESETS = [5, 10, 15, 30, 45, 60];
const MINUTES_PRESETS = [1, 2, 3, 5, 10, 15, 30, 45];
const HOURS_PRESETS = [1, 2, 3, 6, 12, 24];
const DAYS_PRESETS = [1, 2, 3, 7, 14, 30];

const totalsFromPresets = (
  seconds: number[] = [],
  minutes: number[] = [],
  hours: number[] = [],
  days: number[] = []
): number[] => {
  const totals = new Set<number>();
  for (const value of seconds) totals.add(value);
  for (const value of minutes) totals.add(value * 60);
  for (const value of hours) totals.add(value * 3600);
  for (const value of days) totals.add(value * 86400);
  return [...totals].sort((a, b) => a - b);
};

export const buildJobScheduleOptions = (
  interval: JobScheduleInterval
): JobScheduleOption[] => {
  let totals: number[] = [];

  switch (interval) {
    case 'seconds':
      totals = totalsFromPresets(SECONDS_PRESETS);
      break;
    case 'minutes':
      totals = totalsFromPresets(
        [],
        MINUTES_PRESETS,
        HOURS_PRESETS,
        DAYS_PRESETS
      );
      break;
    case 'hours':
      totals = totalsFromPresets([], [], HOURS_PRESETS, DAYS_PRESETS);
      break;
    case 'days':
      totals = totalsFromPresets([], [], [], DAYS_PRESETS);
      break;
  }

  return totals.map((totalSeconds) => toDisplayOption(totalSeconds));
};

export const toDisplayOption = (totalSeconds: number): JobScheduleOption => {
  const { displayUnit, displayValue } = secondsToDisplay(totalSeconds);
  return { totalSeconds, displayUnit, displayValue };
};

export const secondsToDisplay = (
  totalSeconds: number
): Pick<JobScheduleOption, 'displayUnit' | 'displayValue'> => {
  if (totalSeconds < 60) {
    return { displayUnit: 'seconds', displayValue: totalSeconds };
  }

  if (totalSeconds % 86400 === 0) {
    return {
      displayUnit: 'days',
      displayValue: totalSeconds / 86400,
    };
  }

  if (totalSeconds % 3600 === 0) {
    return {
      displayUnit: 'hours',
      displayValue: totalSeconds / 3600,
    };
  }

  if (totalSeconds % 60 === 0) {
    return {
      displayUnit: 'minutes',
      displayValue: totalSeconds / 60,
    };
  }

  return { displayUnit: 'seconds', displayValue: totalSeconds };
};

export const withCurrentScheduleOption = (
  options: JobScheduleOption[],
  totalSeconds: number
): JobScheduleOption[] => {
  if (options.some((option) => option.totalSeconds === totalSeconds)) {
    return options;
  }

  return [...options, toDisplayOption(totalSeconds)].sort(
    (a, b) => a.totalSeconds - b.totalSeconds
  );
};

export const parseCronToTotalSeconds = (
  cronSchedule: string,
  interval: JobScheduleInterval
): number => {
  const parts = cronSchedule.trim().split(/\s+/);

  if (parts.length !== 6) {
    return 300;
  }

  const [second, minute, hour, , day] = parts;

  switch (interval) {
    case 'seconds': {
      if (second.startsWith('*/')) {
        const scheduleSeconds = Number(second.slice(2));
        if (scheduleSeconds > 0) {
          return scheduleSeconds;
        }
      }

      if (second === '0' && minute === '*') {
        return 60;
      }

      break;
    }
    case 'minutes': {
      if (minute.startsWith('*/')) {
        const scheduleMinutes = Number(minute.slice(2));
        if (scheduleMinutes > 0) {
          return scheduleMinutes * 60;
        }
      }

      if (second === '0' && hour === '*' && /^\d+$/.test(minute)) {
        return 3600;
      }

      if (second === '0' && minute === '0' && /^\d+$/.test(hour)) {
        return 86400;
      }

      break;
    }
    case 'hours': {
      if (hour.startsWith('*/')) {
        const scheduleHours = Number(hour.slice(2));
        if (scheduleHours > 0) {
          return scheduleHours * 3600;
        }
      }

      break;
    }
    case 'days': {
      if (day.startsWith('*/')) {
        const scheduleDays = Number(day.slice(2));
        if (scheduleDays > 0) {
          return scheduleDays * 86400;
        }
      }

      break;
    }
  }

  return 300;
};

export const totalSecondsToCron = (
  totalSeconds: number,
  interval: JobScheduleInterval
): string => {
  const cron = ['0', '0', '*', '*', '*', '*'];

  switch (interval) {
    case 'seconds':
      cron[0] = `*/${totalSeconds}`;
      cron[1] = '*';
      break;
    case 'minutes':
      cron[1] = `*/${totalSeconds / 60}`;
      break;
    case 'hours':
      cron[2] = `*/${totalSeconds / 3600}`;
      break;
    case 'days':
      cron[2] = '1';
      cron[3] = `*/${totalSeconds / 86400}`;
      break;
    default:
      throw new Error('Cannot convert schedule for fixed-interval jobs.');
  }

  return cron.join(' ');
};

export const DEFAULT_DAILY_TIME = '04:00';

// Daily time-of-day schedule helpers (used by the backup job + its settings
// tab): convert between a "HH:MM" time and a 6-field cron "0 MM HH * * *".
export const cronToDailyTime = (cron: string | undefined): string => {
  if (!cron) {
    return DEFAULT_DAILY_TIME;
  }
  const parts = cron.trim().split(/\s+/);
  // 6-field "s m h dom mon dow" (with seconds) or 5-field "m h dom mon dow".
  const [minuteStr, hourStr] =
    parts.length >= 6 ? [parts[1], parts[2]] : [parts[0], parts[1]];
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59
  ) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(
      2,
      '0'
    )}`;
  }
  return DEFAULT_DAILY_TIME;
};

export const dailyTimeToCron = (time: string): string => {
  const [hourStr, minuteStr] = time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const hh = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 4;
  const mm =
    Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;
  return `0 ${mm} ${hh} * * *`;
};
