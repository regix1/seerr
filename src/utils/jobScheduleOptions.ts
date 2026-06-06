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

const MINUTE_VALUES = [5, 10, 15, 20, 30, 45];
const ARR_EXTRA_MINUTE_VALUES = [90];
const HOUR_VALUES = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72];
const DAY_VALUES = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21];

const SECONDS_JOB_OPTIONS = Array.from({ length: 60 }, (_, index) => index + 1);

export const buildJobScheduleOptions = (
  interval: JobScheduleInterval,
  jobId?: string
): JobScheduleOption[] => {
  const includeArrExtras = jobId === 'radarr-scan' || jobId === 'sonarr-scan';

  const totals = new Set<number>();

  if (interval === 'seconds') {
    for (const seconds of SECONDS_JOB_OPTIONS) {
      totals.add(seconds);
    }
  } else if (interval === 'minutes') {
    for (const minutes of MINUTE_VALUES) {
      totals.add(minutes * 60);
    }
    if (includeArrExtras) {
      for (const minutes of ARR_EXTRA_MINUTE_VALUES) {
        totals.add(minutes * 60);
      }
    }
    for (const hours of HOUR_VALUES) {
      totals.add(hours * 3600);
    }
    for (const days of DAY_VALUES) {
      totals.add(days * 86400);
    }
  } else if (interval === 'hours') {
    for (const hours of HOUR_VALUES) {
      totals.add(hours * 3600);
    }
    for (const days of DAY_VALUES) {
      totals.add(days * 86400);
    }
  } else if (interval === 'days') {
    for (const days of DAY_VALUES) {
      totals.add(days * 86400);
    }
  }

  return [...totals]
    .sort((a, b) => a - b)
    .map((totalSeconds) => toDisplayOption(totalSeconds));
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
