import { assertCsrf } from "../../../../../server/product/authority/csrf";
import { collaborationService } from "../../../../../server/product/collaboration/runtime";
import { parseCookie, PRODUCT_SESSION_COOKIE } from "../../../../../server/product/http/cookies";
import { failure, success } from "../../../../../server/product/http/errors";
import { productSessionService } from "../../../../../server/product/session/runtime";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<Response>{try{const sid=parseCookie(request.headers.get("cookie"),PRODUCT_SESSION_COOKIE);const session=productSessionService().current(sid);assertCsrf(request,session);const body=await request.json() as Record<string,unknown>;if(typeof body.originalName!=="string"||typeof body.contentType!=="string"||!Number.isInteger(body.sizeBytes))throw new Error("collaboration_request_invalid");return success(await collaborationService().initiateAttachment(session,{originalName:body.originalName,contentType:body.contentType,sizeBytes:body.sizeBytes as number}),{status:201});}catch(e){return failure(e);}}
