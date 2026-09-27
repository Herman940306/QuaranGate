import "server-only";
import { createHash } from "node:crypto";
import type {
  SecurityAssessmentAdmissionReceipt,
} from "../../../../../src/shared/securityAssessment";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import type { SecurityAssessmentReadScope } from "./assessment";

function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) out[key] = stable(object[key]);
  return out;
}

export function validateSecurityAssessmentAdmissionReceipt(value: unknown): SecurityAssessmentAdmissionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_invalid");
  }
  const r = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "bridgeRequestId", "assessmentId", "assessmentVersion",
    "correlationId", "decision", "decisionCode", "decisionAt", "decisionExpiresAt",
    "admissionReceiptDigest", "resolvedPrincipalId", "resolvedProjectId",
    "resolvedTargetId", "resolvedSourceRevision", "policyVersion", "resourceClass",
    "networkClass", "credentialClass",
  ]);
  if (Object.keys(r).some((key) => !allowed.has(key))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_unknown_field");
  }
  if (
    r.schemaVersion !== "BE9_ADMISSION_RECEIPT_V1"
    || !/^bar_[0-9a-f]{24}$/.test(String(r.bridgeRequestId))
    || !/^assessment_[0-9a-f]{24}$/.test(String(r.assessmentId))
    || !Number.isSafeInteger(r.assessmentVersion)
    || typeof r.correlationId !== "string"
    || !["ADMITTED", "DENIED_POLICY", "FAILED_PRECONDITION", "TEMPORARILY_UNAVAILABLE", "REPLAY_REJECTED"].includes(String(r.decision))
    || !/^[A-Z][A-Z0-9_:-]{0,127}$/.test(String(r.decisionCode))
    || !/^[0-9a-f]{64}$/.test(String(r.admissionReceiptDigest))
    || r.policyVersion !== "BE9_ADMISSION_POLICY_V1"
    || r.resourceClass !== "STATIC_SOURCE"
    || r.networkClass !== "NONE"
    || r.credentialClass !== "NONE"
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_invalid");
  }
  for (const key of ["decisionAt", "decisionExpiresAt"] as const) {
    const raw = r[key];
    if (typeof raw !== "string") {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_time_invalid");
    }
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== raw) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_time_invalid");
    }
  }
  const { admissionReceiptDigest, ...unsigned } = r;
  const digest = createHash("sha256").update(JSON.stringify(stable(unsigned))).digest("hex");
  if (digest !== admissionReceiptDigest) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_digest_invalid");
  }
  return r as unknown as SecurityAssessmentAdmissionReceipt;
}

export interface SecurityAssessmentEvidenceIndexItem {
  type: string;
  producerClass: string;
  sha256Hex: string;
  sizeBytes: number;
  truncated: boolean;
  finalized: boolean;
  createdAt: string;
  finalizedAt?: string;
}

export interface SecurityAssessmentEvidenceStore {
  recordAdmission(
    scope: SecurityAssessmentReadScope,
    receipt: SecurityAssessmentAdmissionReceipt,
  ): Promise<void>;
  list(
    scope: SecurityAssessmentReadScope,
    assessmentId: string,
  ): Promise<{
    admissions: SecurityAssessmentAdmissionReceipt[];
    evidence: SecurityAssessmentEvidenceIndexItem[];
  }>;
}

export class MemorySecurityAssessmentEvidenceStore implements SecurityAssessmentEvidenceStore {
  private readonly admissions = new Map<string, SecurityAssessmentAdmissionReceipt[]>();

  async recordAdmission(
    _scope: SecurityAssessmentReadScope,
    receipt: SecurityAssessmentAdmissionReceipt,
  ): Promise<void> {
    validateSecurityAssessmentAdmissionReceipt(receipt);
    const values = this.admissions.get(receipt.assessmentId) ?? [];
    values.push(structuredClone(receipt));
    this.admissions.set(receipt.assessmentId, values);
  }

  async list(
    _scope: SecurityAssessmentReadScope,
    assessmentId: string,
  ): Promise<{
    admissions: SecurityAssessmentAdmissionReceipt[];
    evidence: SecurityAssessmentEvidenceIndexItem[];
  }> {
    return {
      admissions: (this.admissions.get(assessmentId) ?? []).map((receipt) => structuredClone(receipt)),
      evidence: [],
    };
  }
}

interface AdmissionRow {
  receipt_digest_sha256: string;
  receipt_json: unknown;
}
interface EvidenceRow {
  evidence_type: string;
  producer_class: string;
  sha256_hex: string;
  size_bytes: string | number;
  truncated: boolean;
  finalized: boolean;
  created_at: Date | string;
  finalized_at: Date | string | null;
}

function iso(value: Date | string, code: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  return parsed.toISOString();
}

export class PostgresSecurityAssessmentEvidenceStore implements SecurityAssessmentEvidenceStore {
  constructor(private readonly db: QueryExecutor) {}

  async recordAdmission(
    scope: SecurityAssessmentReadScope,
    receipt: SecurityAssessmentAdmissionReceipt,
  ): Promise<void> {
    validateSecurityAssessmentAdmissionReceipt(receipt);
    const result = await this.db.query(
      `INSERT INTO security_assessment_admission_receipts(
         receipt_digest_sha256, assessment_id, organization_id, workspace_id,
         assessment_version, decision, decision_code, receipt_schema_version,
         receipt_json, decision_at, expires_at
       )
       SELECT $1, a.assessment_id, a.organization_id, a.workspace_id,
              $2, $3, $4, $5, $6::jsonb, $7, $8
         FROM security_assessments a
        WHERE a.assessment_id = $9
          AND a.product_user_id = $10
          AND a.organization_id = $11
          AND a.workspace_id = $12
          AND a.principal_ref = $13
       ON CONFLICT (receipt_digest_sha256) DO NOTHING`,
      [
        receipt.admissionReceiptDigest,
        receipt.assessmentVersion,
        receipt.decision,
        receipt.decisionCode,
        receipt.schemaVersion,
        JSON.stringify(receipt),
        receipt.decisionAt,
        receipt.decisionExpiresAt,
        receipt.assessmentId,
        scope.productUserId,
        scope.organizationId,
        scope.workspaceId,
        scope.principalRef,
      ],
    );
    if (result.rowCount === 0) {
      const exists = await this.db.query(
        `SELECT 1
           FROM security_assessment_admission_receipts r
           JOIN security_assessments a ON a.assessment_id = r.assessment_id
          WHERE r.receipt_digest_sha256 = $1
            AND a.assessment_id = $2
            AND a.product_user_id = $3
            AND a.organization_id = $4
            AND a.workspace_id = $5
            AND a.principal_ref = $6`,
        [
          receipt.admissionReceiptDigest,
          receipt.assessmentId,
          scope.productUserId,
          scope.organizationId,
          scope.workspaceId,
          scope.principalRef,
        ],
      );
      if (exists.rowCount !== 1) {
        throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "assessment_forbidden");
      }
    }
  }

  async list(scope: SecurityAssessmentReadScope, assessmentId: string) {
    const owned = await this.db.query(
      `SELECT 1 FROM security_assessments
        WHERE assessment_id=$1 AND product_user_id=$2
          AND organization_id=$3 AND workspace_id=$4 AND principal_ref=$5`,
      [
        assessmentId,
        scope.productUserId,
        scope.organizationId,
        scope.workspaceId,
        scope.principalRef,
      ],
    );
    if (owned.rowCount !== 1) {
      throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    }

    const admissions = await this.db.query<AdmissionRow & Record<string, unknown>>(
      `SELECT receipt_digest_sha256, receipt_json
         FROM security_assessment_admission_receipts
        WHERE assessment_id=$1
        ORDER BY decision_at ASC, receipt_digest_sha256 ASC
        LIMIT 101`,
      [assessmentId],
    );
    if (admissions.rows.length > 100) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "assessment_admission_receipt_set_too_large");
    }

    const evidence = await this.db.query<EvidenceRow & Record<string, unknown>>(
      `SELECT evidence_type, producer_class, sha256_hex, size_bytes,
              truncated, finalized, created_at, finalized_at
         FROM security_assessment_evidence
        WHERE assessment_id=$1
        ORDER BY created_at ASC, evidence_id ASC
        LIMIT 1001`,
      [assessmentId],
    );
    if (evidence.rows.length > 1000) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "assessment_evidence_set_too_large");
    }

    return {
      admissions: admissions.rows.map((row) => {
        const receipt = validateSecurityAssessmentAdmissionReceipt(row.receipt_json);
        if (receipt.admissionReceiptDigest !== row.receipt_digest_sha256
          || receipt.assessmentId !== assessmentId) {
          throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_binding_invalid");
        }
        return receipt;
      }),
      evidence: evidence.rows.map((row) => {
        const sizeBytes = Number(row.size_bytes);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0
          || !/^[A-Z][A-Z0-9_:-]{0,95}$/.test(row.evidence_type)
          || !["ADMISSION", "SOURCE_STAGING", "SCANNER_OUTPUT", "CLEANUP", "RECOVERY"].includes(row.producer_class)
          || !/^[0-9a-f]{64}$/.test(row.sha256_hex)) {
          throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_evidence_row_invalid");
        }
        return {
          type: row.evidence_type,
          producerClass: row.producer_class,
          sha256Hex: row.sha256_hex,
          sizeBytes,
          truncated: row.truncated,
          finalized: row.finalized,
          createdAt: iso(row.created_at, "assessment_evidence_time_invalid"),
          ...(row.finalized_at
            ? { finalizedAt: iso(row.finalized_at, "assessment_evidence_time_invalid") }
            : {}),
        };
      }),
    };
  }
}
