import {runtimePerformance} from '../observability/runtime-performance.js';

/** All page mutations and the entire send/receipt sequence share one queue. */
export class AccountActor {
  private interactive: (() => Promise<void>)[] = [];
  private background: (() => Promise<void>)[] = [];
  private draining = false;
  private interactiveTurns = 0;
  get idle():boolean {return !this.draining&&!this.interactive.length&&!this.background.length;}
  run<T>(operation: () => Promise<T>, priority: "interactive" | "background" = "interactive"): Promise<T> {
    const waited=runtimePerformance.start('QUEUE_WAIT');
    const result = new Promise<T>((resolve, reject) => {
      this[priority].push(async () => {
        waited();
        try { resolve(await operation()); } catch (error) { reject(error); }
      });
    });
    if (!this.draining) {
      this.draining = true;
      queueMicrotask(() => void this.drain());
    }
    return result;
  }
  private async drain(): Promise<void> {
    while (this.interactive.length || this.background.length) {
      const background = this.background.length > 0 && (!this.interactive.length || this.interactiveTurns >= 3);
      const operation = (background ? this.background : this.interactive).shift()!;
      this.interactiveTurns = background ? 0 : this.interactiveTurns + 1;
      await operation();
    }
    this.draining = false;
  }
}
