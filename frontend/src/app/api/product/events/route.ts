import { collaborationService } from "../../../../server/product/collaboration/runtime";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../server/product/http/cookies";
import { failure, success } from "../../../../server/product/http/errors";
import { productSessionService } from "../../../../server/product/session/runtime";
export const dynamic="force-dynamic";
export async function GET(request:Request):Promise<Response>{try{const sid=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(sid);const url=new URL(request.url);const limitRaw=url.searchParams.get("limit");const limit=limitRaw===null?50:Number(limitRaw);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("collaboration_request_invalid");return success(await collaborationService().replayEvents(session,url.searchParams.get("cursor")??undefined,limit));}catch(e){return failure(e);}}
