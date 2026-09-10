import Link from "next/link";

export const metadata = {
  title: "隐私政策 - PuerHub 普洱茶社区",
  description: "PuerHub 隐私政策：我们收集哪些信息（账号、内容、日志、Cookie）、如何使用与保护、绝不出售、您的查阅更正删除权利与联系方式。",
};

const SECTIONS: { title: string; paras: string[] }[] = [
  {
    title: "1. 引言",
    paras: [
      "PuerHub（\"我们\"，本站 puer.im）非常重视您的个人隐私。本政策说明我们在您使用本社区服务时收集哪些信息、如何使用与保护这些信息。使用本社区即表示您同意本政策所述的做法。",
    ],
  },
  {
    title: "2. 我们收集的信息",
    paras: [
      "账号信息：注册时提供的用户名、电子邮箱（仅用于登录与安全通知，不在站内公开展示）以及经散列存储的密码。",
      "您发布的内容：帖子、评论、品鉴笔记、图片及相关的交互数据（投票、关注、收藏）。",
      "技术日志：访问日志（IP 地址、浏览器类型、访问时间）用于安全防护与故障排查。",
      "Cookie 与本地存储：仅用于维持登录状态、记住阅读位置等必要功能，不用于第三方广告跟踪。",
    ],
  },
  {
    title: "3. 信息的使用",
    paras: [
      "我们将收集的信息用于：提供并改进社区功能（如热榜排序、已读标记）、账号安全验证、处理举报与违规内容、以及非常少量的站内运营统计。",
      "我们不会将您的个人信息出售或出租给任何第三方，也不会用于与本社区服务无关的用途。",
    ],
  },
  {
    title: "4. 信息的共享",
    paras: [
      "除以下情形外，我们不会共享您的个人信息：（1）获得您的明确同意；（2）为遵守法律法规或司法机关的正式要求；（3）为保护本社区及用户的合法权益（如反欺诈）。",
      "如您公开发布了内容，这些内容将按您设置的可见范围对其他用户可见——请注意不要在公开内容中包含自己的敏感信息。",
    ],
  },
  {
    title: "5. 数据安全与保留",
    paras: [
      "我们采取传输加密（HTTPS）、密码散列存储、访问控制等业界通行措施保护数据。但互联网传输不存在绝对安全，请妥善保管您的账号密码。",
      "账号数据在您使用期间保留；您可以通过站内渠道申请注销账号，我们将在合理期限内删除或匿名化您的个人数据。",
    ],
  },
  {
    title: "6. 您的权利",
    paras: [
      "您有权查阅、更正自己的账号信息与发布内容，可随时编辑或删除；如需注销账号或导出数据，请联系社区管理员。",
      "如认为我们处理个人信息的方式侵犯了您的权益，可以通过站内举报/反馈渠道提出。",
    ],
  },
  {
    title: "7. 未成年人",
    paras: [
      "本社区面向成年茶友，不接受未满 18 周岁用户注册。若发现未成年人账号，我们将予以注销。",
    ],
  },
  {
    title: "8. 政策更新",
    paras: [
      "本政策如有重大变更，我们将通过站内公告通知。继续使用本社区即表示接受更新后的政策。",
    ],
  },
];

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">隐私政策</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-2">PuerHub 隐私政策</h1>
      <p className="text-sm text-stone-500 mb-6">最近更新：2026 年 9 月 10 日</p>
      <div className="space-y-5">
        {SECTIONS.map((s) => (
          <section key={s.title} className="bg-white border border-stone-200 rounded-lg p-4 md:p-5">
            <h2 className="text-base md:text-lg font-semibold text-stone-800 mb-1.5">{s.title}</h2>
            {s.paras.map((p, i) => (
              <p key={i} className="text-sm text-stone-600 leading-relaxed mb-1.5 last:mb-0">{p}</p>
            ))}
          </section>
        ))}
      </div>
      <p className="text-sm text-stone-500 mt-6">
        相关文档：
        <Link href="/rules" className="text-amber-700 hover:underline mx-1">社区规则</Link>·
        <Link href="/terms" className="text-amber-700 hover:underline mx-1">用户协议</Link>
      </p>
    </div>
  );
}

