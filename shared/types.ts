export type DeviceType = "iOS" | "Android" | "Desktop" | "Other";
export type LinkStatus = "active" | "paused";

export interface SmartLink {
  id: string;
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
  groupId?: string | null;
  tags: string[];
  status: LinkStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LinkGroup {
  id: string;
  name: string;
  color: string;
}

export interface ClickEvent {
  id: string;
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
