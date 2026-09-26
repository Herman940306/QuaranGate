export type ProductRecordStatus = "active" | "disabled";
export type ContainerRecordStatus = ProductRecordStatus | "archived";

export interface ProductUserRecord {
  id: string;
  issuer: string;
  subject: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  status: ProductRecordStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  status: ContainerRecordStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  organizationId: string;
  name: string;
  status: ContainerRecordStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipRecord {
  id: string;
  productUserId: string;
  organizationId: string;
  workspaceId?: string;
  roleClassification: string;
  status: ProductRecordStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveProductRole {
  roleClassification: string;
  permissions: string[];
}

export interface UserPreferencesRecord {
  productUserId: string;
  appearanceMode: "system" | "light" | "dark";
  palette: string;
  density: "comfortable" | "compact";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceUpdate {
  appearanceMode: UserPreferencesRecord["appearanceMode"];
  palette: string;
  density: UserPreferencesRecord["density"];
  expectedVersion: number;
}
