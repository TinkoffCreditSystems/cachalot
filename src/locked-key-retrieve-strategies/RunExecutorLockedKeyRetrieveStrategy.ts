import { LockedKeyRetrieveStrategy } from "../LockedKeyRetrieveStrategy";
import { ExecutorContext, runExecutor } from "../Executor";

/**
 * This locked key retrieve strategy is default and suitable for most cases. It just
 * runs executor and returns value from it.
 */
export class RunExecutorLockedKeyRetrieveStrategy implements LockedKeyRetrieveStrategy {
  public getName(): string {
    return "runExecutor";
  }

  async get<R>(context: ExecutorContext<R>): Promise<R> {
    return runExecutor(context.executor);
  }
}
