"use client";

interface Metrics {
  totalUsers: number;
  todayUsers: number;
  yesterdayUsers: number;
  todayArticles: number;
  yesterdayArticles: number;
  activeSessions: number;
  pendingReports: number;
}

interface Engagement {
  totalViews: number;
  totalVotes: number;
  todayVotes: number;
  yesterdayVotes: number;
  totalLikes: number;
  todayLikes: number;
  yesterdayLikes: number;
}

interface Activity {
  type: "article" | "comment" | "report";
  id: string;
  title: string;
  user: string;
  createdAt: string;
}

interface TrendPoint {
  date: string;
  count: number;
}

interface Props {
  metrics: Metrics;
  activities: Activity[];
  trend: { users: TrendPoint[]; articles: TrendPoint[]; views: TrendPoint[] };
  engagement: Engagement;
}

function changeLabel(today: number, yesterday: number) {
  if (yesterday === 0) return today > 0 ? "+100%" : "—";
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function MiniBar({ data }: { data: TrendPoint[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  const recent = data.slice(-14);
  return (
    <div className="flex items-end gap-0.5 h-12">
      {recent.map((d, i) => (
        <div
          key={i}
          className="flex-1 bg-amber-200 rounded-t-sm min-w-[3px]"
          style={{ height: `${(d.count / max) * 100}%` }}
          title={`${d.date}: ${d.count}`}
        />
      ))}
    </div>
  );
}

const TYPE_ICON = { article: "📝", comment: "💬", report: "🚨" };
const TYPE_LABEL = { article: "帖子", comment: "评论", report: "举报" };

export default function DashboardClient({ metrics, activities, trend, engagement }: Props) {
  const cards = [
    {
      label: "总用户",
      value: metrics.totalUsers.toLocaleString(),
      sub: `今日 +${metrics.todayUsers} (${changeLabel(metrics.todayUsers, metrics.yesterdayUsers)})`,
      icon: "👥",
    },
    {
      label: "今日新帖",
      value: metrics.todayArticles.toLocaleString(),
      sub: `昨日 ${metrics.yesterdayArticles} (${changeLabel(metrics.todayArticles, metrics.yesterdayArticles)})`,
      icon: "📝",
    },
    {
      label: "活跃茶会",
      value: metrics.activeSessions.toLocaleString(),
      sub: "邀请中 + 已确认 + 进行中",
      icon: "🍵",
    },
    {
      label: "待处理举报",
      value: metrics.pendingReports.toLocaleString(),
      sub: metrics.pendingReports > 0 ? "需要尽快处理" : "一切正常",
      icon: "🚨",
    },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold text-stone-800 mb-6">管理概览</h1>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="bg-white border border-stone-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{c.icon}</span>
              <span className="text-sm text-stone-500">{c.label}</span>
            </div>
            <p className="text-2xl font-bold text-stone-800">{c.value}</p>
            <p className="text-xs text-stone-400 mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* 7-day view trend (needs daily snapshots to accumulate) */}
      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-8">
        <h3 className="text-sm font-medium text-stone-600 mb-3">每日浏览趋势（近7天）</h3>
        {trend.views.length > 0 ? (
          <MiniBar data={trend.views} />
        ) : (
          <p className="text-xs text-stone-400 py-4 text-center">
            数据积累中（每天 00:05 记录一次快照,初期点少,7 天后完整）
          </p>
        )}
      </div>

      {/* Engagement metrics: views / votes / likes */}
      <h2 className="text-sm font-medium text-stone-500 mb-3 mt-2">互动数据</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-stone-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">👁️</span>
            <span className="text-sm text-stone-500">总浏览</span>
          </div>
          <p className="text-2xl font-bold text-stone-800">{engagement.totalViews.toLocaleString()}</p>
          <p className="text-xs text-stone-400 mt-1">全站累计</p>
        </div>
        <div className="bg-white border border-stone-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">👍</span>
            <span className="text-sm text-stone-500">投票</span>
          </div>
          <p className="text-2xl font-bold text-stone-800">{engagement.totalVotes.toLocaleString()}</p>
          <p className="text-xs text-stone-400 mt-1">
            今日 +{engagement.todayVotes} ({changeLabel(engagement.todayVotes, engagement.yesterdayVotes)})
          </p>
        </div>
        <div className="bg-white border border-stone-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">❤️</span>
            <span className="text-sm text-stone-500">点赞</span>
          </div>
          <p className="text-2xl font-bold text-stone-800">{engagement.totalLikes.toLocaleString()}</p>
          <p className="text-xs text-stone-400 mt-1">
            今日 +{engagement.todayLikes} ({changeLabel(engagement.todayLikes, engagement.yesterdayLikes)})
          </p>
        </div>
      </div>

      {/* Trend charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="bg-white border border-stone-200 rounded-lg p-4">
          <h3 className="text-sm font-medium text-stone-600 mb-3">用户注册趋势（近14天）</h3>
          <MiniBar data={trend.users} />
        </div>
        <div className="bg-white border border-stone-200 rounded-lg p-4">
          <h3 className="text-sm font-medium text-stone-600 mb-3">发帖趋势（近14天）</h3>
          <MiniBar data={trend.articles} />
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-white border border-stone-200 rounded-lg p-4">
        <h3 className="text-sm font-medium text-stone-600 mb-3">最近活动</h3>
        <div className="divide-y divide-stone-100">
          {activities.map((a, i) => (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <span className="text-base">{TYPE_ICON[a.type]}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-stone-700 truncate">
                  <span className="text-stone-400">[{TYPE_LABEL[a.type]}]</span>{" "}
                  {a.title}
                </p>
                <p className="text-xs text-stone-400">
                  {a.user} · {new Date(a.createdAt).toLocaleString("zh-CN")}
                </p>
              </div>
            </div>
          ))}
          {activities.length === 0 && (
            <p className="text-sm text-stone-400 py-4 text-center">暂无活动</p>
          )}
        </div>
      </div>
    </div>
  );
}
