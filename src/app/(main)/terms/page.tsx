import Link from "next/link";

export const metadata = {
  title: "用户协议 - PuerHub 普洱茶社区",
  description: "PuerHub 用户协议（服务条款）：账号注册与安全、用户内容的权利与许可、可接受使用、内容审核、免责声明与责任限制。",
};

const SECTIONS: { title: string; paras: string[] }[] = [
  {
    title: "1. 协议的接受",
    paras: [
      "本协议是您与 PuerHub（puer.im）之间关于使用本社区服务具有约束力的合同。注册账号或使用本社区即表示您已阅读、理解并同意本协议及《社区规则》《隐私政策》的全部内容。",
    ],
  },
  {
    title: "2. 服务说明",
    paras: [
      "PuerHub 提供普洱茶主题的论坛交流、茶品百科、品鉴笔记与行情讨论等在线服务。我们可能不时新增、调整或停止部分功能；重大变更将提前以站内公告通知。",
    ],
  },
  {
    title: "3. 账号注册与安全",
    paras: [
      "您承诺注册时提供真实、准确的信息，并妥善保管账号与密码；账号项下的一切操作均视为您本人所为。",
      "禁止转让、出售账号，或一人注册多个账号用于刷票、规避封禁等目的。发现账号被盗用请立即通知管理员。",
    ],
  },
  {
    title: "4. 用户内容",
    paras: [
      "权利归属：您对自己发布的帖子、评论、图片等内容（\"用户内容\"）保留全部知识产权。",
      "使用许可：为运营和展示本服务的需要，您授予 PuerHub 非独占、可撤回的许可，在站内（含不同终端与页面布局）存储、展示您的用户内容。删除内容后该许可随之终止（缓存与备份中的残留除外）。",
      "内容责任：您须对自己发布的内容负责，保证不侵犯他人权利且符合《社区规则》。因用户内容引发的纠纷由发布者本人承担。",
    ],
  },
  {
    title: "5. 可接受使用",
    paras: [
      "您同意不利用本服务从事《社区规则》所禁止的行为，包括发布违法有害信息、垃圾广告、侵犯隐私、盗用内容、干扰服务正常运行（如爬虫滥用、恶意攻击）等。",
    ],
  },
  {
    title: "6. 内容审核与账号处理",
    paras: [
      "我们有权但无义务预先审查用户内容。对违规内容可予以编辑、折叠或删除，对违规账号可予以警告、禁言、限制功能或封禁。",
    ],
  },
  {
    title: "7. 免责声明",
    paras: [
      "本服务按\"现状\"提供，不作任何明示或默示的保证。",
      "站内的品鉴感受、仓储建议与行情讨论均为用户个人观点，不构成购买、收藏或投资建议。茶品交易请自行核实信息并谨慎决策，交易风险自担。",
    ],
  },
  {
    title: "8. 责任限制",
    paras: [
      "在法律允许的最大范围内，PuerHub 对因使用或无法使用本服务造成的间接、附带、惩罚性损失不承担责任；对我们承担的全部责任，累计赔偿额不超过您为使用本服务已支付的费用（本社区服务免费，即为零）。",
    ],
  },
  {
    title: "9. 协议的变更与终止",
    paras: [
      "我们可能不时修订本协议，重大变更将以站内公告通知；若您在变更后继续使用本社区，即视为接受修订后的协议。",
      "您可随时停止使用并申请注销账号。若您严重违反本协议，我们可暂停或终止向您提供服务。",
    ],
  },
];

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">用户协议</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-2">PuerHub 用户协议</h1>
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
        <Link href="/privacy" className="text-amber-700 hover:underline mx-1">隐私政策</Link>
      </p>
    </div>
  );
}

