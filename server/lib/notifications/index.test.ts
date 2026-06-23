import notificationManager, { Notification } from '@server/lib/notifications';
import type {
  NotificationAgent,
  NotificationPayload,
} from '@server/lib/notifications/agents/agent';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// A tiny controllable agent so we can assert fan-out isolation without any
// real transport.
class TestAgent implements NotificationAgent {
  public sent = 0;
  public constructor(
    private readonly behavior: 'ok' | 'reject' | 'throw',
    private readonly enabled = true
  ) {}

  public shouldSend(): boolean {
    return this.enabled;
  }

  public async send(): Promise<boolean> {
    this.sent += 1;
    if (this.behavior === 'reject') {
      return Promise.reject(new Error('agent rejected'));
    }
    if (this.behavior === 'throw') {
      throw new Error('agent threw synchronously');
    }
    return true;
  }
}

const samplePayload: NotificationPayload = {
  subject: 'Test subject',
  notifySystem: true,
  notifyAdmin: false,
};

function trackUnhandledRejections(): {
  count: () => number;
  restore: () => void;
} {
  let count = 0;
  const handler = (): void => {
    count += 1;
  };
  process.on('unhandledRejection', handler);
  return {
    count: () => count,
    restore: () => {
      process.off('unhandledRejection', handler);
    },
  };
}

describe('NotificationManager.sendNotification fan-out', () => {
  let tracker: ReturnType<typeof trackUnhandledRejections>;

  beforeEach(() => {
    tracker = trackUnhandledRejections();
    // Reset the (private) agent registry between tests.
    (
      notificationManager as unknown as { activeAgents: NotificationAgent[] }
    ).activeAgents = [];
  });

  afterEach(() => {
    tracker.restore();
    (
      notificationManager as unknown as { activeAgents: NotificationAgent[] }
    ).activeAgents = [];
  });

  it('does not surface an unhandled rejection when an agent rejects, and still runs the others', async () => {
    const rejecting = new TestAgent('reject');
    const healthy = new TestAgent('ok');
    notificationManager.registerAgents([rejecting, healthy]);

    notificationManager.sendNotification(
      Notification.MEDIA_PENDING,
      samplePayload
    );

    // Let the fan-out promises settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(rejecting.sent, 1);
    assert.equal(
      healthy.sent,
      1,
      'a sibling failure must not block other agents'
    );
    assert.equal(
      tracker.count(),
      0,
      'a rejecting agent must not produce an unhandled rejection'
    );
  });

  it('isolates an agent that throws synchronously', async () => {
    const thrower = new TestAgent('throw');
    const healthy = new TestAgent('ok');
    notificationManager.registerAgents([thrower, healthy]);

    notificationManager.sendNotification(
      Notification.MEDIA_APPROVED,
      samplePayload
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(healthy.sent, 1);
    assert.equal(tracker.count(), 0);
  });

  it('skips agents whose shouldSend() returns false', async () => {
    const disabled = new TestAgent('ok', false);
    const enabled = new TestAgent('ok', true);
    notificationManager.registerAgents([disabled, enabled]);

    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      samplePayload
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(disabled.sent, 0);
    assert.equal(enabled.sent, 1);
  });
});
