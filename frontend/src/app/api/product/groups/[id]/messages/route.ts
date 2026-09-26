import { assertCsrf } from "../../../../../../server/product/authority/csrf";
import { collaborationService } from "../../../../../../server/product/collaboration/runtime";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../../server/product/session/runtime";
export const dynamic="force-dynamic";
type Ctx={params:Promise<{id:string}>};
export async function GET(request:Request,ctx:Ctx):Promise<Response>{try{const id=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(id);const url=new URL(request.url);const limitRaw=url.searchParams.get("limit");const limit=limitRaw===null?50:Number(limitRaw);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("collaboration_request_invalid");return success(await collaborationService().listMessages(session,(await ctx.params).id,url.searchParams.get("cursor")??undefined,limit));}catch(e){return failure(e);}}
export async function POST(request:Request,ctx:Ctx):Promise<Response>{try{const id=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(id);assertCsrf(request,session);const body=await request.json() as Record<string,unknown>;if(typeof body.body!=="string")throw new Error("collaboration_request_invalid");return success(await collaborationService().createMessage(session,(await ctx.params).id,body.body,request.headers.get("idempotency-key")??undefined),{status:201});}catch(e){return failure(e);}}
