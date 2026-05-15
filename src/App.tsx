import {
  Activity,
  BarChart3,
  ChevronDown,
  Code2,
  Copy,
  Download,
  Edit3,
  Filter,
  Info,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  MousePointerClick,
  Plus,
  RefreshCcw,
  Search,
  Shuffle,
  Sparkles,
  Trash2,
  User,
  X
} from "lucide-react";
import { CSSProperties, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { AnalyticsPayload, ApiKeyPermission, ApiKeySummary, AuthUser, BreakdownPoint, ClickEvent, CreatedApiKey, DashboardSummary, LinkGroup, LinkWithStats, SmartLink } from "../shared/types";

type View = "dashboard" | "links" | "analytics" | "api";
type SortMode = "newest" | "oldest" | "most-clicks" | "least-clicks" | "name-asc" | "name-desc";
type ApiDocsTab = "manual" | "prompt";

const blankAnalytics: AnalyticsPayload = {
  clicksOverTime: [],
  deviceBreakdown: [],
  countryBreakdown: [],
  referrerBreakdown: [],
  browserBreakdown: [],
  dailyBreakdown: [],
  linkPerformance: [],
  recentEvents: []
};

const initialGroups: LinkGroup[] = [
  { id: "campaign", name: "Campaign", color: "#6366f1" },
  { id: "mobile", name: "Mobile", color: "#06b6d4" },
  { id: "referral", name: "Referral", color: "#22c55e" },
  { id: "press", name: "Press", color: "#ec4899" }
];

const shortLinkOrigin = "https://tapsocials.com";
const shortLinkHost = new URL(shortLinkOrigin).host;

export function App() {
  const [view, setView] = useState<View>(() => currentView());
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [links, setLinks] = useState<LinkWithStats[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsPayload>(blankAnalytics);
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [groups, setGroups] = useState<LinkGroup[]>(initialGroups);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [isGroupOpen, setGroupOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<LinkGroup | null>(null);
  const [editingLink, setEditingLink] = useState<LinkWithStats | null>(null);
  const [statsLink, setStatsLink] = useState<LinkWithStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = () => setView(currentView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then((user) => {
        if (!cancelled) setAuthUser(user);
      })
      .catch(() => {
        if (!cancelled) setAuthUser(null);
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser) return;
    void refresh(days);
  }, [days, authUser]);

  useEffect(() => {
    if (!authUser || view !== "api") return;
    void refreshApiKeys();
  }, [authUser, view]);

  async function refresh(nextDays = days) {
    try {
      setLoading(true);
      setError(null);
      const [summaryData, linksData, analyticsData, groupsData] = await Promise.all([
        api.summary(),
        api.links(),
        api.analytics(nextDays),
        api.groups()
      ]);
      setSummary(summaryData);
      setLinks(linksData);
      setAnalytics(analyticsData);
      setGroups(groupsData);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Unable to load dashboard.";
      if (message.includes("Authentication required")) {
        setError("Your session could not be verified for that request. Please refresh the page and try again.");
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshApiKeys() {
    try {
      setApiKeys(await api.apiKeys());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load API keys.");
    }
  }

  async function handleAuth(user: AuthUser) {
    setAuthUser(user);
    setError(null);
    await refresh(days);
  }

  async function logout() {
    await api.logout();
    setAuthUser(null);
    setSummary(null);
    setLinks([]);
    setAnalytics(blankAnalytics);
    setApiKeys([]);
  }

  async function saveApiKey(name: string, permissions: ApiKeyPermission[]): Promise<CreatedApiKey> {
    const created = await api.createApiKey({ name, permissions });
    setApiKeys((current) => [created.key, ...current]);
    return created;
  }

  async function removeApiKey(key: ApiKeySummary) {
    if (!window.confirm(`Delete "${key.name}" API key? This cannot be undone.`)) return;
    await api.deleteApiKey(key.id);
    setApiKeys((current) => current.filter((item) => item.id !== key.id));
  }

  function navigate(nextView: View) {
    const path = nextView === "dashboard" ? "/dashboard" : `/dashboard/${nextView}`;
    window.history.pushState({}, "", path);
    setView(nextView);
  }

  async function saveLink(payload: Partial<SmartLink>) {
    if (editingLink) {
      await api.updateLink(editingLink.id, payload);
      setEditingLink(null);
    } else {
      await api.createLink(payload);
      setCreateOpen(false);
    }
    await refresh();
  }

  async function removeLink(link: LinkWithStats) {
    if (!window.confirm("Are you sure you want to delete this link?")) return;
    await api.deleteLink(link.id);
    await refresh();
  }

  async function assignGroup(link: LinkWithStats, groupId: string | null) {
    await api.updateLink(link.id, { groupId });
    await refresh();
  }

  function openCreateGroup() {
    setEditingGroup(null);
    setGroupOpen(true);
  }

  function closeGroupModal() {
    setEditingGroup(null);
    setGroupOpen(false);
  }

  function editGroup(group: LinkGroup) {
    setEditingGroup(group);
    setGroupOpen(true);
  }

  async function saveGroup(name: string, color: string) {
    const clean = name.trim();
    if (!clean) return;
    if (editingGroup) {
      const updated = await api.updateGroup(editingGroup.id, { name: clean, color });
      setGroups((current) => current.map((group) => (group.id === updated.id ? updated : group)));
    } else {
      const group = await api.createGroup({ name: clean, color });
      setGroups((current) => [...current, group]);
    }
    closeGroupModal();
  }

  async function removeGroup(group: LinkGroup) {
    if (!window.confirm(`Delete "${group.name}" group? Links in this group will stay active.`)) return;
    await api.deleteGroup(group.id);
    setGroups((current) => current.filter((item) => item.id !== group.id));
    setLinks((current) => current.map((link) => (link.groupId === group.id ? { ...link, groupId: null } : link)));
    setGroupFilter((current) => (current === group.id ? null : current));
  }

  const filteredLinks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const selectedGroup = groups.find((group) => group.id === groupFilter);
    const result = links.filter((link) => {
      const groupMatch =
        !selectedGroup ||
        link.groupId === selectedGroup.id ||
        link.tags.some((tag) => tag.toLowerCase() === selectedGroup.name.toLowerCase());
      const text = `${link.name} ${link.slug} ${link.fallbackUrl} ${link.description} ${link.tags.join(" ")}`.toLowerCase();
      return groupMatch && (!needle || text.includes(needle));
    });

    result.sort((a, b) => {
      if (sortMode === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (sortMode === "most-clicks") return b.clicks - a.clicks;
      if (sortMode === "least-clicks") return a.clicks - b.clicks;
      if (sortMode === "name-asc") return a.name.localeCompare(b.name);
      if (sortMode === "name-desc") return b.name.localeCompare(a.name);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return result;
  }, [groupFilter, groups, links, query, sortMode]);

  if (authLoading) return <Skeleton />;

  if (!authUser) {
    return <AuthScreen onAuthenticated={(user) => void handleAuth(user)} error={error} />;
  }

  return (
    <div className="app-shell">
      <Sidebar active={view} user={authUser} onNavigate={navigate} onLogout={() => void logout()} />

      <main className="workspace">
        <Header
          title={viewTitle(view)}
          subtitle={viewSubtitle(view)}
          action={view === "analytics" ? <ExportButton analytics={analytics} /> : null}
        />

        {error ? <div className="notice error">{error}</div> : null}
        {loading && !summary ? <Skeleton /> : null}

        {!loading || summary ? (
          <>
            {view === "dashboard" ? <DashboardView summary={summary} analytics={analytics} /> : null}
            {view === "links" ? (
              <LinksView
                links={filteredLinks}
                allLinks={links}
                groups={groups}
                selectedGroup={groupFilter}
                query={query}
                sortMode={sortMode}
                onQueryChange={setQuery}
                onSortChange={setSortMode}
                onGroupSelect={setGroupFilter}
                onCreateGroup={openCreateGroup}
                onEditGroup={editGroup}
                onDeleteGroup={(group) => void removeGroup(group)}
                onCreate={() => setCreateOpen(true)}
                onEdit={setEditingLink}
                onDelete={(link) => void removeLink(link)}
                onAssignGroup={(link, groupId) => void assignGroup(link, groupId)}
                onStats={setStatsLink}
                onRefresh={() => void refresh()}
              />
            ) : null}
            {view === "analytics" ? <AnalyticsView analytics={analytics} days={days} onDaysChange={setDays} /> : null}
            {view === "api" ? <ApiView keys={apiKeys} onCreateKey={saveApiKey} onDeleteKey={(key) => void removeApiKey(key)} /> : null}
          </>
        ) : null}
      </main>

      {isCreateOpen || editingLink ? (
        <LinkModal
          editLink={editingLink}
          onClose={() => {
            setCreateOpen(false);
            setEditingLink(null);
          }}
          onSubmit={saveLink}
        />
      ) : null}
      {statsLink ? <StatsModal link={statsLink} events={analytics.recentEvents} onClose={() => setStatsLink(null)} /> : null}
      {isGroupOpen ? <GroupModal editGroup={editingGroup} onClose={closeGroupModal} onSubmit={saveGroup} /> : null}
    </div>
  );
}

function AuthScreen({ onAuthenticated, error }: { onAuthenticated: (user: AuthUser) => void; error: string | null }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(error);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setAuthError(null);
    try {
      const user = mode === "signup" ? await api.signup({ name, email, password }) : await api.login({ email, password });
      onAuthenticated(user);
    } catch (requestError) {
      setAuthError(requestError instanceof Error ? requestError.message : "Authentication failed.");
      setSaving(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <Brand />
        <div className="auth-tabs">
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Sign up
          </button>
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Log in
          </button>
        </div>

        {mode === "signup" ? (
          <label className="field">
            <span>Name</span>
            <div className="input-with-icon">
              <User size={16} />
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoComplete="name" />
            </div>
          </label>
        ) : null}

        <label className="field">
          <span>Email</span>
          <div className="input-with-icon">
            <Mail size={16} />
            <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" />
          </div>
        </label>

        <label className="field">
          <span>Password</span>
          <input required minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        </label>

        {authError ? <div className="notice error auth-error">{authError}</div> : null}

        <button className="button primary auth-submit" type="submit" disabled={saving}>
          {saving ? "Please wait..." : mode === "signup" ? "Create Account" : "Log In"}
        </button>
      </form>
    </main>
  );
}

function Sidebar({ active, user, onNavigate, onLogout }: { active: View; user: AuthUser; onNavigate: (view: View) => void; onLogout: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  function navigateMobile(view: View) {
    onNavigate(view);
    setMobileOpen(false);
  }

  return (
    <>
      <aside className="sidebar desktop-sidebar" aria-label="Primary">
        <Brand />
        <NavList active={active} onNavigate={onNavigate} />
        <div className="sidebar-footer">
          <div>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <button className="icon-button ghost" type="button" title="Log out" aria-label="Log out" onClick={onLogout}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="mobile-bar">
        <button className="icon-button ghost" type="button" title="Menu" aria-label="Menu" onClick={() => setMobileOpen((open) => !open)} aria-expanded={mobileOpen}>
          <Menu size={20} />
        </button>
        <Brand compact />
        <button className="icon-button ghost mobile-logout" type="button" title="Log out" aria-label="Log out" onClick={onLogout}>
          <LogOut size={17} />
        </button>
      </div>
      {mobileOpen ? (
        <div className="mobile-menu">
          <NavList active={active} onNavigate={navigateMobile} />
        </div>
      ) : null}
    </>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <div className="brand-mark">
        <img src="/tapsocials-logo.svg?v=2" alt="" aria-hidden="true" />
      </div>
      <span>TapSocials</span>
    </div>
  );
}

function NavList({ active, onNavigate }: { active: View; onNavigate: (view: View) => void }) {
  return (
    <nav className="nav-list">
      <NavButton active={active === "dashboard"} icon={<LayoutDashboard size={18} />} label="Dashboard" onClick={() => onNavigate("dashboard")} />
      <NavButton active={active === "links"} icon={<Link2 size={18} />} label="Links" onClick={() => onNavigate("links")} />
      <NavButton active={active === "analytics"} icon={<BarChart3 size={18} />} label="Analytics" onClick={() => onNavigate("analytics")} />
      <NavButton active={active === "api"} icon={<Code2 size={18} />} label="API" onClick={() => onNavigate("api")} />
    </nav>
  );
}

function Header({ title, subtitle, action }: { title: string; subtitle: string; action: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action ? <div className="header-actions">{action}</div> : null}
    </header>
  );
}

function DashboardView({ summary, analytics }: { summary: DashboardSummary | null; analytics: AnalyticsPayload }) {
  const data = summary || {
    totalClicks: 0,
    activeLinks: 0,
    uniqueVisitors: 0,
    deepLinkRate: 0,
    trend: [],
    topLinks: [],
    recentEvents: []
  };
  const staleLinks = data.topLinks.filter((link) => link.clicks === 0).concat(data.topLinks.length ? [] : []);

  return (
    <section className="page-content">
      <div className="stat-grid five">
        <StatCard title="Total Clicks" value={data.totalClicks} change="+18% from last week" changeType="positive" icon={<MousePointerClick />} />
        <StatCard title="Unique Clicks" value={data.uniqueVisitors} icon={<Activity />} />
        <StatCard title="Active Links" value={data.activeLinks} icon={<Link2 />} />
        <StatCard title="Today's Clicks" value={todayValue(data.trend)} change={`${Math.max(1, Math.floor(todayValue(data.trend) * 0.72))} unique`} icon={<Sparkles />} />
        <StatCard title="Unique Regions" value={analytics.countryBreakdown.length || 0} icon={<Filter />} />
      </div>

      <div className="dashboard-grid">
        <Panel title="Clicks Over Time">
          <LineChart points={data.trend} />
        </Panel>
        <Panel title="Top Performing Links">
          <RankedLinks links={data.topLinks} />
        </Panel>
      </div>

      <Panel
        title="Needs Attention"
        aside={
          <select className="select compact" defaultValue="3">
            <option value="1">Last 1 day</option>
            <option value="2">Last 2 days</option>
            <option value="3">Last 3 days</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        }
        icon={<Info size={18} />}
      >
        {staleLinks.length ? (
          <div className="attention-list">
            {staleLinks.map((link) => (
              <div className="attention-row" key={link.id}>
                <Link2 size={16} />
                <div>
                  <strong>{link.name}</strong>
                  <small>{link.description || "No clicks in the selected period"}</small>
                </div>
                <span>No clicks ever</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-message">All links are performing well - no attention needed.</div>
        )}
      </Panel>

      <Panel title="All Links Performance">
        <div className="performance-list">
          {analytics.linkPerformance.map((link) => (
            <div className="performance-row" key={link.id}>
              <div>
                <strong>{link.name}</strong>
                <small>{link.fallbackUrl}</small>
              </div>
              <span>{formatNumber(link.clicks)} clicks</span>
              <span>{formatNumber(link.uniqueVisitors)} unique</span>
              <TypeBadge deep={isDeepLink(link)} />
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function LinksView({
  links,
  allLinks,
  groups,
  selectedGroup,
  query,
  sortMode,
  onQueryChange,
  onSortChange,
  onGroupSelect,
  onCreateGroup,
  onEditGroup,
  onDeleteGroup,
  onCreate,
  onEdit,
  onDelete,
  onAssignGroup,
  onStats,
  onRefresh
}: {
  links: LinkWithStats[];
  allLinks: LinkWithStats[];
  groups: LinkGroup[];
  selectedGroup: string | null;
  query: string;
  sortMode: SortMode;
  onQueryChange: (value: string) => void;
  onSortChange: (value: SortMode) => void;
  onGroupSelect: (value: string | null) => void;
  onCreateGroup: () => void;
  onEditGroup: (group: LinkGroup) => void;
  onDeleteGroup: (group: LinkGroup) => void;
  onCreate: () => void;
  onEdit: (link: LinkWithStats) => void;
  onDelete: (link: LinkWithStats) => void;
  onAssignGroup: (link: LinkWithStats, groupId: string | null) => void;
  onStats: (link: LinkWithStats) => void;
  onRefresh: () => void;
}) {
  const normalCount = allLinks.filter((link) => !isDeepLink(link)).length;
  const deepCount = allLinks.filter(isDeepLink).length;

  return (
    <section className="page-content">
      <div className="links-toolbar">
        <div>
          <h2>All Links</h2>
          <div className="count-line">
            <span>{normalCount}/∞ links</span>
            <span>•</span>
            <span>{deepCount}/∞ deep links</span>
          </div>
        </div>
        <div className="toolbar-actions">
          <label className="search-field">
            <Search size={16} />
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search links..." />
          </label>
          <SortMenu value={sortMode} onChange={onSortChange} />
          <button className="button primary" type="button" onClick={onCreate}>
            <Plus size={16} />
            Create Link
          </button>
        </div>
      </div>

      <GroupBar groups={groups} selectedGroup={selectedGroup} onSelect={onGroupSelect} onCreate={onCreateGroup} onEdit={onEditGroup} onDelete={onDeleteGroup} />

      <section className="links-table">
        <div className="links-table-head">
          <span>Link</span>
          <span>Clicks</span>
          <span>Type</span>
          <span>Actions</span>
        </div>
        <div className="links-table-body">
          {links.length ? (
            links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                groups={groups}
                onEdit={() => onEdit(link)}
                onDelete={() => onDelete(link)}
                onAssignGroup={(groupId) => onAssignGroup(link, groupId)}
                onStats={() => onStats(link)}
                onRefresh={onRefresh}
              />
            ))
          ) : (
            <div className="empty-message table-empty">No links match your search.</div>
          )}
        </div>
      </section>
    </section>
  );
}

function AnalyticsView({ analytics, days, onDaysChange }: { analytics: AnalyticsPayload; days: number; onDaysChange: (days: number) => void }) {
  const total = analytics.clicksOverTime.reduce((sum, point) => sum + point.value, 0);
  const unique = analytics.linkPerformance.reduce((sum, link) => sum + link.uniqueVisitors, 0);
  const week = analytics.clicksOverTime.slice(-7).reduce((sum, point) => sum + point.value, 0);
  const month = analytics.clicksOverTime.reduce((sum, point) => sum + point.value, 0);

  return (
    <section className="page-content">
      <div className="date-toolbar">
        <select className="select" value={days} onChange={(event) => onDaysChange(Number(event.target.value))}>
          <option value={1}>Today</option>
          <option value={7}>Last 7 Days</option>
          <option value={14}>Last 14 Days</option>
          <option value={30}>Last 30 Days</option>
          <option value={90}>Last 90 Days</option>
        </select>
      </div>

      <div className="stat-grid">
        <SmallMetric label="Total Clicks" value={total} detail={`${unique} unique`} />
        <SmallMetric label="Today" value={todayValue(analytics.clicksOverTime)} detail="latest daily count" accent />
        <SmallMetric label="This Week" value={week} detail="rolling 7 days" />
        <SmallMetric label="This Month" value={month} detail="selected range" />
      </div>

      <div className="dashboard-grid">
        <Panel title={`Clicks Over Time (${daysLabel(days)})`}>
          <LineChart points={analytics.clicksOverTime} />
        </Panel>
        <Panel title="Top Regions">
          <BreakdownList points={analytics.countryBreakdown} />
        </Panel>
      </div>

      <div className="dashboard-grid">
        <Panel title="Devices">
          <BreakdownList points={analytics.deviceBreakdown} />
        </Panel>
        <Panel title="Browsers">
          <BreakdownList points={analytics.browserBreakdown} />
        </Panel>
      </div>

      <Panel title="Daily Breakdown">
        <DailyBreakdownTable rows={analytics.dailyBreakdown} />
      </Panel>
    </section>
  );
}

const apiBaseUrl = `${shortLinkOrigin}/api/public`;
const apiPermissionOptions: { value: ApiKeyPermission; label: string; detail: string }[] = [
  { value: "create_links", label: "Create Links", detail: "Create and delete normal tracking links." },
  { value: "create_deep_links", label: "Create Deep Links", detail: "Allow API-created links to use Safari/Chrome escape." },
  { value: "get_stats", label: "Get Click Stats", detail: "List links and read click statistics." }
];

function ApiView({
  keys,
  onCreateKey,
  onDeleteKey
}: {
  keys: ApiKeySummary[];
  onCreateKey: (name: string, permissions: ApiKeyPermission[]) => Promise<CreatedApiKey>;
  onDeleteKey: (key: ApiKeySummary) => void;
}) {
  const [tab, setTab] = useState<ApiDocsTab>("manual");
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <section className="page-content api-page">
      <section className="panel api-hero">
        <div>
          <h2>API Keys</h2>
          <p>Use API keys to programmatically create links and fetch statistics.</p>
        </div>
        <button className="button primary" type="button" onClick={() => setModalOpen(true)}>
          <Plus size={16} />
          New Key
        </button>
      </section>

      <div className="api-tabs" role="tablist" aria-label="API documentation">
        <button type="button" role="tab" aria-selected={tab === "manual"} className={tab === "manual" ? "active" : ""} onClick={() => setTab("manual")}>
          User Manual
        </button>
        <button type="button" role="tab" aria-selected={tab === "prompt"} className={tab === "prompt" ? "active" : ""} onClick={() => setTab("prompt")}>
          AI Integration Prompt
        </button>
      </div>

      {tab === "manual" ? <ApiManual /> : <ApiPrompt />}

      <section className="api-key-grid" aria-label="API keys">
        {keys.length ? (
          keys.map((key) => <ApiKeyCard key={key.id} apiKey={key} onDelete={() => onDeleteKey(key)} />)
        ) : (
          <div className="empty-message table-empty">No API keys yet.</div>
        )}
      </section>

      {modalOpen ? <ApiKeyModal onClose={() => setModalOpen(false)} onCreate={onCreateKey} /> : null}
    </section>
  );
}

function ApiManual() {
  return (
    <section className="panel api-doc-panel" role="tabpanel" aria-label="User Manual">
      <h3>TapSocials API - User Manual</h3>
      <p>The TapSocials API lets you programmatically create tracking links, retrieve click statistics, list your links, and delete links. All requests use API keys.</p>

      <h4>Getting Started</h4>
      <ul className="api-list">
        <li>Click <strong>New Key</strong> above to create an API key.</li>
        <li>Choose which permissions the key should have: Create Links, Deep Links, and Stats.</li>
        <li><strong>Copy the key immediately.</strong> It is shown only once and cannot be retrieved later.</li>
        <li>Include the key in every request using the <code>x-api-key</code> header.</li>
      </ul>

      <ApiCodeBlock label="Base URL" code={apiBaseUrl} />

      <ApiEndpoint method="POST" path="/create-link" permission="create_links" description="Creates a new tracking link. Deep links also require create_deep_links.">
        <ApiCodeBlock
          label="Request Body"
          code={`{
  "title": "My Campaign",
  "destination_url": "https://example.com",
  "is_deep_link": false,
  "short_code": "my-slug"
}`}
        />
        <ApiCodeBlock
          label="Response"
          code={`{
  "link": {
    "id": "lnk_...",
    "title": "My Campaign",
    "short_code": "my-slug",
    "destination_url": "https://example.com",
    "is_deep_link": false,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}`}
        />
      </ApiEndpoint>

      <ApiEndpoint method="GET" path="/get-stats?link_id=LINK_ID" permission="get_stats" description="Returns click analytics for one link.">
        <ApiCodeBlock
          label="Response"
          code={`{
  "link": { "id": "...", "title": "...", "short_code": "..." },
  "totalClicks": 1542,
  "uniqueClicks": 823,
  "dailyStats": [{ "date": "2026-05-15", "clicks": 45, "uniqueClicks": 28 }],
  "countryStats": [{ "country": "US", "clicks": 500 }]
}`}
        />
      </ApiEndpoint>

      <ApiEndpoint method="GET" path="/list-links" permission="get_stats" description="Returns up to 500 of your links, newest first." />

      <ApiEndpoint method="POST" path="/delete-link" permission="create_links" description="Permanently deletes a link and its click data.">
        <ApiCodeBlock label="Request Body" code={`{ "link_id": "lnk_..." }`} />
      </ApiEndpoint>

      <h4>Error Handling</h4>
      <ul className="api-list compact">
        <li><strong>401</strong> - Missing or invalid API key</li>
        <li><strong>403</strong> - Permission not enabled for this key</li>
        <li><strong>400</strong> - Missing required fields or short code conflict</li>
        <li><strong>404</strong> - Link not found or does not belong to you</li>
      </ul>

      <ApiCodeBlock
        label="Example: cURL"
        code={`curl -X POST ${apiBaseUrl}/create-link \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: flk_your_key_here" \\
  -d '{"title":"My Link","destination_url":"https://example.com"}'`}
      />
    </section>
  );
}

function ApiPrompt() {
  const prompt = `# TapSocials API Integration Guide

## Overview
You are integrating with the TapSocials link management API. The API can create tracking links and deep links, retrieve click statistics, list links, and delete links.

## Authentication
Send the API key in the x-api-key HTTP header.

Base URL:
${apiBaseUrl}

Endpoints:
- POST /create-link
- GET /get-stats?link_id=LINK_ID
- GET /list-links
- POST /delete-link

Create link body:
{
  "title": "Campaign A",
  "destination_url": "https://example.com",
  "is_deep_link": false,
  "short_code": "optional-slug"
}

Permissions:
- create_links: create and delete links
- create_deep_links: create deep links with Safari/Chrome escape
- get_stats: list links and read analytics

API keys start with flk_ and are shown only once.`;

  return (
    <section className="panel api-doc-panel" role="tabpanel" aria-label="AI Integration Prompt">
      <div className="api-doc-heading">
        <div>
          <h3>AI Integration Prompt</h3>
          <p>Copy this prompt into Cursor, ChatGPT, Claude, or any AI tool to help it integrate with TapSocials.</p>
        </div>
        <CopyButton text={prompt} />
      </div>
      <pre className="api-prompt">{prompt}</pre>
    </section>
  );
}

function ApiEndpoint({ method, path, permission, description, children }: { method: string; path: string; permission: ApiKeyPermission; description: string; children?: ReactNode }) {
  return (
    <section className="api-endpoint">
      <div className="api-endpoint-title">
        <span>{method}</span>
        <code>{path}</code>
      </div>
      <p>{description} Requires <strong>{permission}</strong>.</p>
      {children}
    </section>
  );
}

function ApiCodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="api-code-block">
      <div>
        <span>{label}</span>
        <CopyButton text={code} />
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyTextToClipboard(text);
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button className={`icon-button ghost ${copied ? "success" : ""}`} type="button" title="Copy" aria-label="Copy" onClick={() => void copy()}>
      <Copy size={16} />
    </button>
  );
}

function ApiKeyCard({ apiKey, onDelete }: { apiKey: ApiKeySummary; onDelete: () => void }) {
  return (
    <article className="api-key-card">
      <div>
        <strong>{apiKey.name}</strong>
        <code>{apiKey.prefix}</code>
      </div>
      <div className="api-permissions">
        {apiKey.permissions.includes("create_links") ? <span>Links</span> : null}
        {apiKey.permissions.includes("create_deep_links") ? <span>Deep Links</span> : null}
        {apiKey.permissions.includes("get_stats") ? <span>Stats</span> : null}
      </div>
      <div className="api-key-meta">
        <span>Created {timeAgo(apiKey.createdAt)}</span>
        <span>{apiKey.lastUsedAt ? `Used ${timeAgo(apiKey.lastUsedAt)}` : "Never used"}</span>
      </div>
      <button className="icon-button ghost danger" type="button" title="Delete API key" aria-label={`Delete ${apiKey.name}`} onClick={onDelete}>
        <Trash2 size={16} />
      </button>
    </article>
  );
}

function ApiKeyModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, permissions: ApiKeyPermission[]) => Promise<CreatedApiKey> }) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>(["create_links", "create_deep_links", "get_stats"]);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(permission: ApiKeyPermission) {
    setPermissions((current) => (current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (created) return;
    setSaving(true);
    setError(null);
    try {
      setCreated(await onCreate(name, permissions));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create API key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal api-key-modal" onSubmit={(event) => void submit(event)}>
        <div className="modal-header">
          <h2>
            <KeyRound size={20} />
            Create API Key
          </h2>
          <button className="icon-button ghost" type="button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {created ? (
          <div className="created-key-box">
            <p>Copy this API key now. It will not be shown again.</p>
            <div>
              <code>{created.secret}</code>
              <CopyButton text={created.secret} />
            </div>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Key Name</span>
              <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Production Bot" />
            </label>

            <div className="settings-box">
              <p>Permissions</p>
              {apiPermissionOptions.map((option) => (
                <div className="setting-row" key={option.value}>
                  <div>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </div>
                  <button className={`switch ${permissions.includes(option.value) ? "on" : ""}`} type="button" aria-pressed={permissions.includes(option.value)} onClick={() => toggle(option.value)}>
                    <span />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {error ? <div className="notice error modal-error">{error}</div> : null}

        <div className="modal-actions">
          <button className="button outline" type="button" onClick={onClose}>
            {created ? "Done" : "Cancel"}
          </button>
          {!created ? (
            <button className="button primary" type="submit" disabled={saving || !name.trim() || !permissions.length}>
              {saving ? "Creating..." : "Create Key"}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function SortMenu({ value, onChange }: { value: SortMode; onChange: (value: SortMode) => void }) {
  const [open, setOpen] = useState(false);
  const selected = sortOptions.find((option) => option.value === value) || sortOptions[0];

  function choose(next: SortMode) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className="sort-menu">
      <button className="select-button" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Filter size={16} />
        {selected.label}
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className="dropdown-menu sort-dropdown" role="menu">
          <span>Sort by</span>
          <button type="button" role="menuitem" onClick={() => choose("newest")}>Newest First</button>
          <button type="button" role="menuitem" onClick={() => choose("oldest")}>Oldest First</button>
          <span>By Performance</span>
          <button type="button" role="menuitem" onClick={() => choose("most-clicks")}>Most Clicks</button>
          <button type="button" role="menuitem" onClick={() => choose("least-clicks")}>Least Clicks</button>
          <span>By Name</span>
          <button type="button" role="menuitem" onClick={() => choose("name-asc")}>Name A-Z</button>
          <button type="button" role="menuitem" onClick={() => choose("name-desc")}>Name Z-A</button>
        </div>
      ) : null}
    </div>
  );
}

const sortOptions: { value: SortMode; label: string }[] = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "most-clicks", label: "Most Clicks" },
  { value: "least-clicks", label: "Least Clicks" },
  { value: "name-asc", label: "Name A-Z" },
  { value: "name-desc", label: "Name Z-A" }
];

function GroupBar({
  groups,
  selectedGroup,
  onSelect,
  onCreate,
  onEdit,
  onDelete
}: {
  groups: LinkGroup[];
  selectedGroup: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: (group: LinkGroup) => void;
  onDelete: (group: LinkGroup) => void;
}) {
  const activeGroup = groups.find((group) => group.id === selectedGroup) || null;

  return (
    <div className="group-shell">
      {activeGroup ? (
        <div className="group-actions" aria-label={`${activeGroup.name} group actions`}>
          <button className="group-action-button" type="button" title={`Edit ${activeGroup.name}`} aria-label={`Edit ${activeGroup.name} group`} onClick={() => onEdit(activeGroup)}>
            <Edit3 size={16} />
          </button>
          <button className="group-action-button danger" type="button" title={`Delete ${activeGroup.name}`} aria-label={`Delete ${activeGroup.name} group`} onClick={() => onDelete(activeGroup)}>
            <Trash2 size={16} />
          </button>
        </div>
      ) : null}
      <div className="group-bar">
        <button className={`group-chip ${selectedGroup === null ? "active" : ""}`} type="button" onClick={() => onSelect(null)}>
          All
        </button>
        {groups.map((group) => (
          <button
            className={`group-chip color ${selectedGroup === group.id ? "active" : ""}`}
            style={{ "--chip-color": group.color } as CSSProperties}
            type="button"
            key={group.id}
            onClick={() => onSelect(selectedGroup === group.id ? null : group.id)}
          >
            <span />
            {group.name}
          </button>
        ))}
        <button className="group-chip dashed" type="button" onClick={onCreate}>
          <Plus size={13} />
          New Group
        </button>
      </div>
    </div>
  );
}

const groupColors = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#fb923c", "#facc15", "#22c55e", "#67e8f9"];

function GroupModal({ editGroup, onClose, onSubmit }: { editGroup?: LinkGroup | null; onClose: () => void; onSubmit: (name: string, color: string) => Promise<void> }) {
  const [name, setName] = useState(editGroup?.name || "");
  const [color, setColor] = useState(editGroup?.color || groupColors[0]);
  const [saving, setSaving] = useState(false);
  const isEditing = Boolean(editGroup);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSubmit(name, color);
    } catch (error) {
      console.error(error);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal group-modal" onSubmit={(event) => void submit(event)}>
        <div className="modal-header">
          <h2>{isEditing ? "Edit Group" : "Create Group"}</h2>
          <button className="icon-button ghost" type="button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="field">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Instagram, TikTok, Clients..." autoFocus />
        </label>
        <div className="color-row">
          <span>Color:</span>
          {groupColors.map((swatch) => (
            <button
              key={swatch}
              className={swatch === color ? "active" : ""}
              type="button"
              aria-label={`Select ${swatch}`}
              style={{ "--chip-color": swatch } as CSSProperties}
              onClick={() => setColor(swatch)}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button className="button outline" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={!name.trim() || saving}>
            {isEditing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function LinkRow({
  link,
  groups,
  onEdit,
  onDelete,
  onAssignGroup,
  onStats,
  onRefresh
}: {
  link: LinkWithStats;
  groups: LinkGroup[];
  onEdit: () => void;
  onDelete: () => void;
  onAssignGroup: (groupId: string | null) => void;
  onStats: () => void;
  onRefresh: () => void;
}) {
  const href = shortLinkUrl(link.slug);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const manualCopyRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (copyState !== "failed") return;
    manualCopyRef.current?.focus();
    manualCopyRef.current?.select();
  }, [copyState]);

  async function copyLink() {
    const copied = await copyTextToClipboard(href);
    setCopyState(copied ? "copied" : "failed");
    if (copied) {
      window.setTimeout(() => {
        setCopyState((current) => (current === "copied" ? "idle" : current));
      }, 2200);
    }
  }

  function withClosedMenu(action: () => void) {
    setMenuOpen(false);
    setGroupMenuOpen(false);
    action();
  }

  return (
    <article className="link-row">
      <div className="link-main">
        <span className="row-link-copy" aria-hidden="true">
          <Link2 size={16} />
        </span>
        <div className="link-main-text">
          <strong>{link.name}</strong>
          <small>{link.fallbackUrl}</small>
          {copyState !== "idle" ? <span className={`copy-feedback ${copyState}`}>{copyState === "copied" ? "Copied" : "Select link below"}</span> : null}
          {copyState === "failed" ? (
            <label className="manual-copy">
              <span>Copy manually</span>
              <input ref={manualCopyRef} readOnly value={href} onFocus={(event) => event.currentTarget.select()} />
            </label>
          ) : null}
        </div>
      </div>
      <div className="click-cell">
        <strong>{formatNumber(link.clicks)}</strong>
        <small>clicks</small>
      </div>
      <TypeBadge deep={isDeepLink(link)} />
      <div className="row-actions">
        <button className={`icon-button ghost ${copyState === "copied" ? "success" : ""}`} type="button" title={`Copy ${href}`} aria-label={`Copy link for ${link.name}`} onClick={() => void copyLink()}>
          <Copy size={16} />
        </button>
        <button className="icon-button ghost" type="button" title="View stats" aria-label={`View stats for ${link.name}`} onClick={onStats}>
          <BarChart3 size={16} />
        </button>
        <button className="icon-button ghost" type="button" title="Refresh stats" aria-label={`Refresh stats for ${link.name}`} onClick={onRefresh}>
          <RefreshCcw size={16} />
        </button>
        <button className="icon-button ghost more" type="button" title="More" aria-label={`More actions for ${link.name}`} onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen}>
          <MoreHorizontal size={16} />
        </button>
        {menuOpen ? (
          <div className="row-menu">
            <button type="button" aria-label={`Edit from menu ${link.name}`} onClick={() => withClosedMenu(onEdit)}>
              <Edit3 size={15} />
              Edit
            </button>
            <button type="button" aria-label={`Copy Link for ${link.name}`} onClick={() => void copyLink()}>
              <Copy size={15} />
              Copy Link
            </button>
            <button type="button" aria-label={`Group ${link.name}`} onClick={() => setGroupMenuOpen((open) => !open)} aria-expanded={groupMenuOpen}>
              <Filter size={15} />
              Group
            </button>
            {groupMenuOpen ? (
              <div className="row-submenu">
                <button type="button" onClick={() => withClosedMenu(() => onAssignGroup(null))}>No group</button>
                {groups.map((group) => (
                  <button type="button" key={group.id} onClick={() => withClosedMenu(() => onAssignGroup(group.id))}>
                    <span style={{ "--chip-color": group.color } as CSSProperties} />
                    {group.name}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="danger" aria-label={`Delete from menu ${link.name}`} onClick={() => withClosedMenu(onDelete)}>
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function LinkModal({ editLink, onClose, onSubmit }: { editLink: LinkWithStats | null; onClose: () => void; onSubmit: (payload: Partial<SmartLink>) => Promise<void> }) {
  const isEdit = Boolean(editLink);
  const [title, setTitle] = useState(editLink?.name || "");
  const [destinationUrl, setDestinationUrl] = useState(editLink?.fallbackUrl || "");
  const [notes, setNotes] = useState(editLink?.description || "");
  const [shortCode, setShortCode] = useState(editLink?.slug || "");
  const [customCode, setCustomCode] = useState(Boolean(editLink));
  const [deepLink, setDeepLink] = useState(editLink ? isDeepLink(editLink) : false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    const cleanedSlug = customCode && shortCode ? normalizeShortCode(shortCode, deepLink) : !isEdit ? randomCode(deepLink) : undefined;
    try {
      await onSubmit({
        name: title,
        slug: cleanedSlug,
        description: notes,
        fallbackUrl: destinationUrl,
        webUrl: destinationUrl,
        iosUrl: "",
        androidUrl: "",
        deepLinkPath: "",
        tags: inferTags(notes, title),
        isDeepLink: deepLink,
        forceExternalBrowser: deepLink
      } as Partial<SmartLink>);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to save this link. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={(event) => void submit(event)}>
        <div className="modal-header">
          <h2>{isEdit ? "Edit Link" : "Create New Link"}</h2>
          <button className="icon-button ghost" type="button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <label className="field">
          <span>Title</span>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="My awesome link" />
        </label>

        <label className="field">
          <span>Destination URL</span>
          <input required type="url" value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} placeholder="https://example.com" />
        </label>

        <div className="field">
          <div className="field-row">
            <span>Short Code</span>
            {!isEdit ? (
              <div className="tiny-toggle">
                <button type="button" className={!customCode ? "active" : ""} onClick={() => setCustomCode(false)}>
                  <Shuffle size={14} />
                  Random
                </button>
                <button type="button" className={customCode ? "active" : ""} onClick={() => setCustomCode(true)}>
                  <Edit3 size={14} />
                  Custom
                </button>
              </div>
            ) : null}
          </div>
          {customCode || isEdit ? (
            <div className="short-input-row">
              <span>{shortLinkHost}/</span>
              <input value={shortCode} onChange={(event) => setShortCode(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))} placeholder="my-link" />
              <button className="icon-button" type="button" title="Generate random code" aria-label="Generate random code" onClick={() => setShortCode(randomCode(deepLink))}>
                <Sparkles size={15} />
              </button>
            </div>
          ) : (
            <p className="help-text">A random 8-character code will be generated automatically.</p>
          )}
        </div>

        <label className="field">
          <span>Notes (optional)</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Add some notes about this link..." />
        </label>

        <div className="settings-box">
          <p>Link Settings</p>
          <div className="setting-row">
            <div>
              <span className="setting-title">
                <strong>Deep Link (Safari/Chrome Escape)</strong>
                <span className="setting-tooltip-wrap">
                  <Info size={15} aria-hidden="true" tabIndex={0} />
                  <span className="setting-tooltip" role="tooltip">
                    {isEdit ? (
                      <span>This setting is locked after creation. To change it, create a new link with the desired setting.</span>
                    ) : (
                      <>
                        <span>
                          <strong>Great for Reddit</strong> and direct traffic - auto-opens in Safari/Chrome.
                        </span>
                        <span>For Meta & TikTok, leave this OFF for those links.</span>
                        <span>Can't be changed after creation.</span>
                      </>
                    )}
                  </span>
                </span>
              </span>
              <small>{deepLink ? "Links will auto-open in Safari/Chrome from social apps." : "Links will open normally inside in-app browsers."}</small>
            </div>
            <button className={`switch ${deepLink ? "on" : ""}`} type="button" onClick={() => !isEdit && setDeepLink((value) => !value)} aria-pressed={deepLink} disabled={isEdit}>
              <span />
            </button>
          </div>
          {isEdit ? <small className="warning-text">Locked - create a new link to change this setting.</small> : null}
        </div>

        {formError ? <div className="notice error modal-error">{formError}</div> : null}

        <div className="modal-actions">
          <button className="button outline" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? "Saving..." : isEdit ? "Update Link" : "Create Link"}
          </button>
        </div>
      </form>
    </div>
  );
}

function StatsModal({ link, events, onClose }: { link: LinkWithStats; events: ClickEvent[]; onClose: () => void }) {
  const linkEvents = events.filter((event) => event.linkId === link.id || event.slug === link.slug);
  const scopedEvents = linkEvents.length ? linkEvents : events.filter((event) => event.slug === link.slug);
  const series = buildEventSeries(scopedEvents, 14);
  const countries = breakdownFromEvents(scopedEvents.map((event) => event.country));
  const devices = breakdownFromEvents(scopedEvents.map((event) => event.device));
  const browsers = breakdownFromEvents(scopedEvents.map((event) => event.browser || "Unknown"));
  const thisWeek = scopedEvents.filter((event) => Date.now() - new Date(event.occurredAt).getTime() <= 7 * 24 * 60 * 60 * 1000).length;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal stats-modal">
        <div className="modal-header">
          <h2>
            <BarChart3 size={20} />
            Stats for "{link.name}"
          </h2>
          <div className="modal-header-actions">
            <button className="button outline" type="button">
              <Download size={15} />
              Export
            </button>
            <select className="select compact" defaultValue="14">
              <option value="14">Last 14 Days</option>
              <option value="30">Last 30 Days</option>
              <option value="90">Last 90 Days</option>
            </select>
          </div>
          <button className="icon-button ghost" type="button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="stat-grid">
          <SmallMetric label="Clicks" value={link.clicks} detail="all time" />
          <SmallMetric label="Unique" value={link.uniqueVisitors} detail="visitors" />
          <SmallMetric label="Today" value={todayValue(series)} detail="latest daily count" accent />
          <SmallMetric label="This Week" value={thisWeek} detail="rolling 7 days" />
        </div>
        <Panel title="Clicks Over Time" icon={<Activity size={16} />}>
          <LineChart points={series} />
        </Panel>
        <div className="dashboard-grid">
          <Panel title="Top Regions">
            <BreakdownList points={countries} />
          </Panel>
          <Panel title="Devices">
            <BreakdownList points={devices} />
          </Panel>
        </div>
        <Panel title="Browsers">
          <BreakdownList points={browsers} />
        </Panel>
      </section>
    </div>
  );
}

function StatCard({ title, value, change, changeType = "neutral", icon }: { title: string; value: number | string; change?: string; changeType?: "positive" | "negative" | "neutral"; icon: ReactNode }) {
  return (
    <section className="stat-card">
      <div>
        <p>{title}</p>
        <strong>{typeof value === "number" ? value.toLocaleString() : value}</strong>
        {change ? <small className={changeType}>{change}</small> : null}
      </div>
      <span>{icon}</span>
    </section>
  );
}

function SmallMetric({ label, value, detail, accent = false }: { label: string; value: number; detail: string; accent?: boolean }) {
  return (
    <section className="small-metric">
      <p>{label}</p>
      <strong className={accent ? "accent" : ""}>{formatNumber(value)}</strong>
      <small>{detail}</small>
    </section>
  );
}

function Panel({ title, children, aside, icon }: { title: string; children: ReactNode; aside?: ReactNode; icon?: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          {icon}
          <h2>{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function RankedLinks({ links }: { links: LinkWithStats[] }) {
  if (!links.length) return <div className="empty-message">No links yet</div>;
  return (
    <div className="ranked-list">
      {links.map((link, index) => (
        <div className="ranked-row" key={link.id}>
          <span>{index + 1}</span>
          <strong>{link.name}</strong>
          <code>{formatNumber(link.clicks)}</code>
        </div>
      ))}
    </div>
  );
}

function BreakdownList({ points }: { points: BreakdownPoint[] }) {
  if (!points.length) return <div className="empty-message">No data available</div>;
  return (
    <div className="breakdown-list">
      {points.map((point) => (
        <div className="breakdown-row" key={point.label}>
          <div>
            <strong>{point.label}</strong>
            <span>{formatNumber(point.value)}</span>
          </div>
          <div className="bar-track">
            <span style={{ width: `${Math.max(4, point.percentage)}%` }} />
          </div>
          <small>{point.percentage}%</small>
        </div>
      ))}
    </div>
  );
}

function DailyBreakdownTable({ rows }: { rows: AnalyticsPayload["dailyBreakdown"] }) {
  if (!rows.length) return <div className="empty-message">No daily activity yet.</div>;
  return (
    <div className="daily-table">
      <div className="daily-head">
        <span>Date</span>
        <span>Clicks</span>
        <span>Unique</span>
      </div>
      {rows.map((row) => (
        <div className="daily-row" key={row.label}>
          <span>{row.label}</span>
          <strong>{formatNumber(row.clicks)}</strong>
          <strong>{formatNumber(row.uniqueVisitors)}</strong>
        </div>
      ))}
    </div>
  );
}

function LineChart({ points }: { points: { label: string; value: number }[] }) {
  const max = Math.max(...points.map((point) => point.value), 1);
  const width = 720;
  const height = 280;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coordinates = points.map((point, index) => {
    const x = index * step;
    const y = height - 30 - (point.value / max) * (height - 70);
    return `${x},${y}`;
  });

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Clicks over time" preserveAspectRatio="none">
        {[0, 1, 2, 3].map((line) => (
          <line key={line} x1="0" x2={width} y1={45 + line * 54} y2={45 + line * 54} />
        ))}
        <polyline points={coordinates.join(" ")} />
        {coordinates.map((coordinate, index) => {
          const [x, y] = coordinate.split(",").map(Number);
          return <circle key={`${points[index]?.label}-${index}`} cx={x} cy={y} r="4" />;
        })}
      </svg>
      <div className="chart-labels">
        {points.filter((_, index) => index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2)).map((point) => (
          <span key={point.label}>{point.label}</span>
        ))}
      </div>
    </div>
  );
}

function EventTable({ events }: { events: ClickEvent[] }) {
  if (!events.length) return <div className="empty-message">No click events yet.</div>;
  return (
    <div className="event-list">
      {events.map((event) => (
        <div className="event-row" key={event.id}>
          <Activity size={15} />
          <span>{shortCode(event.slug)}</span>
          <strong>{event.device}</strong>
          <span>{event.referrer}</span>
          <small>{timeAgo(event.occurredAt)}</small>
        </div>
      ))}
    </div>
  );
}

function TypeBadge({ deep }: { deep: boolean }) {
  const description = deep ? "Auto-jumps to Safari/Chrome from social apps. This setting is locked - create a new link to change it." : "Opens normally in in-app browsers. This setting is locked - create a new link to change it.";
  return (
    <span className="type-badge" title={description} aria-label={`${deep ? "Deep Link" : "Normal"}: ${description}`}>
      <span className={deep ? "active" : ""} />
      {deep ? "Deep Link" : "Normal"}
    </span>
  );
}

function ExportButton({ analytics }: { analytics: AnalyticsPayload }) {
  function exportData() {
    const rows = analytics.linkPerformance.map((link) => `${link.name},${link.slug},${link.clicks},${link.uniqueVisitors}`).join("\n");
    const blob = new Blob([`Title,Short URL,Clicks,Unique\n${rows}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "analytics_report.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button className="button outline" type="button" onClick={exportData}>
      <Download size={16} />
      Export to Excel
    </button>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Skeleton() {
  return (
    <div className="page-content">
      <div className="stat-grid five">
        {[0, 1, 2, 3, 4].map((item) => (
          <div className="stat-card skeleton" key={item} />
        ))}
      </div>
      <div className="panel skeleton large" />
    </div>
  );
}

function isDeepLink(link: LinkWithStats | SmartLink): boolean {
  const explicit = (link as SmartLink).isDeepLink;
  if (typeof explicit === "boolean") return explicit;
  return link.slug.startsWith("d-") || Boolean(link.iosUrl || link.androidUrl);
}

function inferTags(notes: string, title: string): string[] {
  const text = `${notes} ${title}`.toLowerCase();
  const tags = ["campaign", "mobile", "referral", "press"].filter((tag) => text.includes(tag));
  return tags.length ? tags : ["mobile"];
}

function normalizeShortCode(value: string, deep: boolean): string {
  const clean = value.replace(/^\/+/, "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  if (deep && !clean.startsWith("d-")) return `d-${clean}`;
  return clean;
}

function randomCode(deep = true): string {
  const code = Math.random().toString(36).slice(2, 10);
  return deep ? `d-${code}` : code;
}

function shortCode(slug: string): string {
  return `/${slug}`;
}

function shortLinkUrl(slug: string): string {
  return `${shortLinkOrigin}/${slug.replace(/^\/+/, "")}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function currentView(): View {
  if (window.location.pathname.includes("/api")) return "api";
  if (window.location.pathname.includes("/analytics")) return "analytics";
  if (window.location.pathname.includes("/links")) return "links";
  return "dashboard";
}

function viewTitle(view: View): string {
  if (view === "api") return "API Keys";
  if (view === "links") return "Links";
  if (view === "analytics") return "Analytics";
  return "Dashboard";
}

function viewSubtitle(view: View): string {
  if (view === "api") return "Manage your API access";
  if (view === "links") return "Manage your tracking links";
  if (view === "analytics") return "Detailed performance metrics";
  return "Overview of your link performance";
}

function daysLabel(days: number): string {
  if (days === 1) return "Today";
  return `Last ${days} Days`;
}

function todayValue(points: { value: number }[]): number {
  return points[points.length - 1]?.value || 0;
}

function buildEventSeries(events: ClickEvent[], days: number) {
  const points = new Map<string, number>();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    points.set(date.toLocaleDateString("en", { month: "short", day: "numeric" }), 0);
  }
  for (const event of events) {
    const label = new Date(event.occurredAt).toLocaleDateString("en", { month: "short", day: "numeric" });
    if (points.has(label)) points.set(label, (points.get(label) || 0) + 1);
  }
  return Array.from(points.entries()).map(([label, value]) => ({ label, value }));
}

function breakdownFromEvents(labels: string[]): BreakdownPoint[] {
  const total = labels.length || 1;
  const counts = labels.reduce<Map<string, number>>((map, label) => {
    map.set(label || "Unknown", (map.get(label || "Unknown") || 0) + 1);
    return map;
  }, new Map());
  return Array.from(counts.entries())
    .map(([label, value]) => ({ label, value, percentage: Math.round((value / total) * 100) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard" }).format(value);
}

function timeAgo(value: string): string {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (copyTextWithSelection(text)) {
    return true;
  }

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea method for browsers with blocked clipboard permission.
    }
  }

  return false;
}

function copyTextWithSelection(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "50%";
  textarea.style.left = "50%";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0.01";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    if (selection) {
      selection.removeAllRanges();
      if (previousRange) selection.addRange(previousRange);
    }
  }
}
