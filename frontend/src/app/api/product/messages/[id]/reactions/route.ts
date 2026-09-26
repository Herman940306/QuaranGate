import { assertCsrf } from "../../../../../../server/product/authority/csrf";
import { collaborationService } from "../../../../../../server/product/collaboration/runtime";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../../server/product/session/runtime";
export const dynamic="force-dynamic";
type Ctx={params:Promise<{id:string}>};
export async function POST(request:Request,ctx:Ctx):Promise<Response>{try{const sid=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(sid);assertCsrf(request,session);const body=await request.json() as Record<string,unknown>;if(typeof body.reaction!=="string")throw new Error("collaboration_request_invalid");await collaborationService().addReaction(session,(await ctx.params).id,body.reaction);return success({accepted:true});}catch(e){return failure(e);}}
