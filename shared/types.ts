export type DeviceType = "iOS" | "Android" | "Desktop" | "Other";
export type LinkStatus = "active" | "paused";
export type ApiKeyPermission = "create_links" | "create_deep_links" | "get_stats";
export type UserRole = "owner" | "admin" | "member";
export type UserStatus = "pending" | "approved" | "suspended";
export type CountryFilterMode = "none" | "block" | "allow";

export interface SmartLink {
  id: string;
  userId?: string;
  name: string;
  slug: string;
  description: string;
  iosUrl: string;
  androidUrl: string;
  webUrl: string;
  fallbackUrl: string;
  deepLinkPath: string;
  notes?: string;
  isDeepLink?: boolean;
  forceExternalBrowser?: boolean;
  groupId?: string | null;
  tags: string[];
  status: LinkStatus;
  countryFilterMode?: CountryFilterMode;
  blockedCountries?: string[];
  allowedCountries?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LinkGroup {
  id: string;
  userId?: string;
  name: string;
  color: string;
  countryFilterMode?: CountryFilterMode;
  blockedCountries?: string[];
  allowedCountries?: string[];
}

export interface ClickEvent {
  id: string;
  userId?: string;
  linkId: string;
  slug: string;
  occurredAt: string;
  device: DeviceType;
  browser?: string;
  country: string;
  referrer: string;
  visitorKey: string;
  destination: string;
}

export interface LinkWithStats extends SmartLink {
  clicks: number;
  uniqueVisitors: number;
  lastClickAt: string | null;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface BreakdownPoint {
  label: string;
  value: number;
  percentage: number;
}

export interface DailyBreakdownPoint {
  label: string;
  clicks: number;
  uniqueVisitors: number;
}

export interface DashboardSummary {
  totalClicks: number;
  activeLinks: number;
  uniqueVisitors: number;
  deepLinkRate: number;
  trend: SeriesPoint[];
  topLinks: LinkWithStats[];
  recentEvents: ClickEvent[];
}

export interface AnalyticsPayload {
  clicksOverTime: SeriesPoint[];
  deviceBreakdown: BreakdownPoint[];
  countryBreakdown: BreakdownPoint[];
  referrerBreakdown: BreakdownPoint[];
  browserBreakdown: BreakdownPoint[];
  dailyBreakdown: DailyBreakdownPoint[];
  linkPerformance: LinkWithStats[];
  recentEvents: ClickEvent[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface TeamMemberStat {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  clicks: number;
  uniqueVisitors: number;
  activeLinks: number;
  totalLinks: number;
  topLinkName: string | null;
  topLinkClicks: number;
  lastClickAt: string | null;
}

export interface TeamAnalyticsPayload {
  totalClicks: number;
  uniqueVisitors: number;
  activeLinks: number;
  totalLinks: number;
  memberCount: number;
  clicksOverTime: SeriesPoint[];
  members: TeamMemberStat[];
}

export interface TeamMember extends AuthUser {}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  permissions: ApiKeyPermission[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedApiKey {
  key: ApiKeySummary;
  secret: string;
}
