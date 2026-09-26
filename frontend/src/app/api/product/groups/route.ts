import { assertCsrf } from "../../../../server/product/authority/csrf";
import { collaborationService } from "../../../../server/product/collaboration/runtime";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../server/product/http/cookies";
import { failure, success } from "../../../../server/product/http/errors";
import { productSessionService } from "../../../../server/product/session/runtime";
export const dynamic="force-dynamic";
export async function GET(request:Request):Promise<Response>{try{const id=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(id);return success(await collaborationService().listGroups(session));}catch(e){return failure(e);}}
export async function POST(request:Request):Promise<Response>{try{const id=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(id);assertCsrf(request,session);const body=await request.json() as Record<string,unknown>;if(typeof body.name!=="string")throw new Error("collaboration_request_invalid");return success(await collaborationService().createGroup(session,body.name,request.headers.get("idempotency-key")??undefined),{status:201});}catch(e){return failure(e);}}
