import "server-only";
export type ProviderAuditEvent="provider.created"|"provider.updated"|"provider.secret_replaced"|"provider.validation_requested"|"provider.validation_completed";
export interface SafeProviderAudit {event:ProviderAuditEvent;outcome:"allowed"|"denied"|"error";correlationId:string;userRef:string;workspaceId:string;providerId:string;kind?:string;code?:string;}
export type ProviderAuditSink=(record:SafeProviderAudit)=>void;
export const defaultProviderAuditSink:ProviderAuditSink=(record)=>console.info(JSON.stringify({type:"product_provider_audit",...record}));