import "server-only";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import type { ProviderCreate, ProviderRow, ProviderUpdate, ProviderValidationUpdate, SafeProvider } from "./types";

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function safe(row: ProviderRow): SafeProvider {
  const version=Number(row.version);
  if(!Number.isSafeInteger(version)||version<0) throw new ProductDataError("PRODUCT_DATA_INVALID","provider_version_invalid");
  return {id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,kind:row.kind,displayLabel:row.display_label,...(row.display_hint?{displayHint:row.display_hint}:{}),configured:row.custody_ref!==null,status:row.status,validation:{status:row.validation_status,...(row.validation_code?{code:row.validation_code}:{}),...(row.validated_at?{validatedAt:iso(row.validated_at)}:{})},version,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};
}
export class ProviderRepository {
  constructor(private readonly db: QueryExecutor) {}
  async list(user:string,org:string,ws:string):Promise<SafeProvider[]> {
    const r=await this.db.query<ProviderRow>(`SELECT p.* FROM product_providers p JOIN memberships m ON m.product_user_id=$1 AND m.organization_id=p.organization_id AND m.workspace_id=p.workspace_id AND m.status='active' JOIN product_users u ON u.id=m.product_user_id AND u.status='active' JOIN workspaces w ON w.id=p.workspace_id AND w.organization_id=p.organization_id AND w.status='active' JOIN organizations o ON o.id=p.organization_id AND o.status='active' WHERE p.organization_id=$2 AND p.workspace_id=$3 ORDER BY p.updated_at DESC,p.id`,[user,org,ws]);
    return r.rows.map(safe);
  }
  async getRow(user:string,org:string,ws:string,id:string):Promise<ProviderRow|undefined>{
    const r=await this.db.query<ProviderRow>(`SELECT p.* FROM product_providers p JOIN memberships m ON m.product_user_id=$1 AND m.organization_id=p.organization_id AND m.workspace_id=p.workspace_id AND m.status='active' JOIN product_users u ON u.id=m.product_user_id AND u.status='active' JOIN workspaces w ON w.id=p.workspace_id AND w.organization_id=p.organization_id AND w.status='active' JOIN organizations o ON o.id=p.organization_id AND o.status='active' WHERE p.organization_id=$2 AND p.workspace_id=$3 AND p.id=$4 LIMIT 1`,[user,org,ws,id]);
    return r.rows[0];
  }
  async get(user:string,org:string,ws:string,id:string):Promise<SafeProvider|undefined>{const row=await this.getRow(user,org,ws,id);return row?safe(row):undefined;}
  async create(user:string,input:ProviderCreate):Promise<SafeProvider>{
    const r=await this.db.query<ProviderRow>(`INSERT INTO product_providers(id,organization_id,workspace_id,kind,display_label,display_hint,custody_ref) SELECT $1,$2,$3,$4,$5,$6,$7 FROM memberships m JOIN product_users u ON u.id=m.product_user_id AND u.status='active' JOIN workspaces w ON w.id=m.workspace_id AND w.organization_id=m.organization_id AND w.status='active' JOIN organizations o ON o.id=m.organization_id AND o.status='active' WHERE m.product_user_id=$8 AND m.organization_id=$2 AND m.workspace_id=$3 AND m.status='active' ON CONFLICT DO NOTHING RETURNING *`,[input.id,input.organizationId,input.workspaceId,input.kind,input.displayLabel,input.displayHint??null,input.custodyRef??null,user]);
    if(!r.rows[0]) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","provider_create_denied"); return safe(r.rows[0]);
  }
  async update(input:ProviderUpdate):Promise<SafeProvider>{
    const r=await this.db.query<ProviderRow>(`UPDATE product_providers p SET display_label=$1,display_hint=$2,status=$3,custody_ref=COALESCE($4,p.custody_ref),validation_status=CASE WHEN $4 IS NULL THEN p.validation_status ELSE 'stale' END,validation_code=CASE WHEN $4 IS NULL THEN p.validation_code ELSE NULL END,validated_at=CASE WHEN $4 IS NULL THEN p.validated_at ELSE NULL END,version=p.version+1,updated_at=CURRENT_TIMESTAMP FROM memberships m,product_users u,workspaces w,organizations o WHERE p.id=$5 AND p.organization_id=$6 AND p.workspace_id=$7 AND p.version=$8 AND m.product_user_id=$9 AND m.organization_id=p.organization_id AND m.workspace_id=p.workspace_id AND m.status='active' AND u.id=m.product_user_id AND u.status='active' AND w.id=p.workspace_id AND w.organization_id=p.organization_id AND w.status='active' AND o.id=p.organization_id AND o.status='active' RETURNING p.*`,[input.displayLabel,input.displayHint??null,input.status,input.custodyRef??null,input.id,input.organizationId,input.workspaceId,input.expectedVersion,input.productUserId]);
    if(!r.rows[0]) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","provider_update_stale_or_denied"); return safe(r.rows[0]);
  }
  async setValidation(input:ProviderValidationUpdate):Promise<SafeProvider>{
    const r=await this.db.query<ProviderRow>(`UPDATE product_providers p SET validation_status=$1,validation_code=$2,validated_at=CURRENT_TIMESTAMP,version=p.version+1,updated_at=CURRENT_TIMESTAMP FROM memberships m,product_users u,workspaces w,organizations o WHERE p.id=$3 AND p.organization_id=$4 AND p.workspace_id=$5 AND p.version=$6 AND m.product_user_id=$7 AND m.organization_id=p.organization_id AND m.workspace_id=p.workspace_id AND m.status='active' AND u.id=m.product_user_id AND u.status='active' AND w.id=p.workspace_id AND w.organization_id=p.organization_id AND w.status='active' AND o.id=p.organization_id AND o.status='active' RETURNING p.*`,[input.status,input.code??null,input.id,input.organizationId,input.workspaceId,input.expectedVersion,input.productUserId]);
    if(!r.rows[0]) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","provider_validation_stale_or_denied"); return safe(r.rows[0]);
  }
}