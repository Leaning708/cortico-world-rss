/** RSS World 测试共用的假宿主:记录推送/延迟事件与 promote 调用,其余宿主接口空实现。 */
import type { EventEnvelope, WorldHost, PushOptions } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushOpts: Array<PushOptions | undefined> = [];
  deferred: Array<{ spec: Record<string, unknown>; opts?: { trigger?: string } }> = [];
  promoted: Array<{ cursor: number; trigger: string }> = [];
  nextCursor = 1;
  log = {
    child: () => this.log,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    emit: () => {},
  } as unknown as WorldHost['log'];
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (): null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128_000 };

  async pushEvent(
    e: Omit<EventEnvelope, 'cursor'>,
    opts?: PushOptions,
  ): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.nextCursor++ } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }

  pushDeferred(spec: never, opts?: { trigger?: string }): void {
    this.deferred.push({ spec: spec as unknown as Record<string, unknown>, opts });
  }

  async promotePending(cursor: number, trigger: 'flush' | 'preempt' | 'interrupt'): Promise<boolean> {
    this.promoted.push({ cursor, trigger });
    return true;
  }

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }

  reportUsage(): void {}

  /** 手动触发已记录的 deferred render(模拟投递时刻)。 */
  renderDeferred(): Array<string | null> {
    return this.deferred.map((entry) => {
      const render = entry.spec.render as () => string | null;
      return render();
    });
  }
}
