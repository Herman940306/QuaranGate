import "server-only";
import { ProviderService } from "./service";
declare global { var __qgProductProviderService: ProviderService | undefined; }
export function productProviderService():ProviderService { if(!globalThis.__qgProductProviderService) globalThis.__qgProductProviderService=new ProviderService(); return globalThis.__qgProductProviderService; }