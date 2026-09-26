import { assertCsrf } from "../../../../../../server/product/authority/csrf";
import { collaborationService } from "../../../../../../server/product/collaboration/runtime";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../../server/product/session/runtime";
export const dynamic="force-dynamic";
type Ctx={params:Promise<{id:string}>};
export async function POST(request:Request,ctx:Ctx):Promise<Response>{try{const sid=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(sid);assertCsrf(request,session);const b=await request.json() as Record<string,unknown>;if((b.decision!=="APPROVED"&&b.decision!=="REJECTED")||!Number.isInteger(b.expectedVersion)||(b.rationale!==undefined&&typeof b.rationale!=="string"))throw new Error("collaboration_request_invalid");return success(await collaborationService().decideApproval(session,(await ctx.params).id,{decision:b.decision,expectedVersion:b.expectedVersion as number,...(typeof b.rationale==="string"?{rationale:b.rationale}:{})}));}catch(e){return failure(e);}}
