import { failure, success } from "../../../../../../server/product/http/errors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return success({ state: "SYNCHRONOUS_BE8_PLAN_ONLY", durableAsyncExecution: "DEFERRED_TO_FUTURE_PHASE", executionAuthority: false });
  } catch (error) {
    return failure(error);
  }
}
