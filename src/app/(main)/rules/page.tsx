import Link from "next/link";

export const metadata = {
  title: "社区规则 - PuerHub 普洱茶社区",
  description: "PuerHub 普洱茶社区行为准则：诚信交流、尊重茶友、反对辱骂骚扰与恶意广告、尊重版权、保护隐私。违反规则的内容将被移除，屡犯者将被封禁。",
};

const RULES: { title: string; body: string }[] = [
  {
    title: "诚信与真实",
    body: "以真实的茶人身份交流。禁止假冒他人身份、伪造品鉴经历、刷票刷评或操纵行情讨论。茶品交易信息应如实描述仓储、年份与品相。",
  },
  {
    title: "禁止辱骂与骚扰",
    body: "对茶品可以有分歧，对茶友必须保持尊重。禁止人身攻击、辱骂、歧视性言论、持续骚扰或煽动对立。观点交锋请对茶不对人。",
  },
  {
    title: "禁止垃圾信息与恶意广告",
    body: "未经社区许可，禁止发布商业广告、引流链接、批量重复内容。茶叶买卖请前往「茶市风云」版块，并遵守当地法律法规。",
  },
  {
    title: "尊重知识产权",
    body: "转载他人文章、图片、视频请注明原作者与出处；禁止盗用他人品鉴笔记或茶品图片冒充自己的内容。收到有效侵权投诉后，社区将及时处理。",
  },
  {
    title: "禁止违法与有害内容",
    body: "禁止发布违反法律法规的内容，包括但不限于涉政敏感、色情低俗、暴力血腥、赌博诈骗、危险物品交易等信息。",
  },
  {
    title: "保护个人隐私",
    body: "禁止在未经当事人同意的情况下公开他人的真实姓名、联系方式、住址、交易记录等个人信息。",
  },
  {
    title: "善用举报",
    body: "发现违规内容请使用帖子/评论的「举报」功能，而非在评论区争吵。社区管理员将依据本规则处理举报。",
  },
  {
    title: "管理员裁量与申诉",
    body: "为维护社区秩序，管理员与版主可对违规内容进行编辑、移除，对违规账号进行警告、禁言或封禁。对处理结果有异议，可通过举报渠道或站内信申诉。",
  },
];

export default function Page() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">社区规则</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold text-stone-800 mb-2">PuerHub 社区规则</h1>
      <p className="text-sm text-stone-500 mb-1">最近更新：2026 年 9 月 10 日</p>
      <p className="text-stone-600 leading-relaxed mb-6">
        PuerHub 是面向普洱茶爱好者的交流社区。以下规则适用于站内全部版块、帖子、评论、品鉴笔记与用户资料。
        注册即表示您同意遵守这些规则。社区依规运营，规则将随社区发展不定期修订并以站内公告形式通知。
      </p>
      <div className="space-y-5">
        {RULES.map((r, idx) => (
          <section key={r.title} className="bg-white border border-stone-200 rounded-lg p-4 md:p-5">
            <h2 className="text-base md:text-lg font-semibold text-stone-800 mb-1.5">
              <span className="text-amber-700 mr-1.5">{idx + 1}.</span>{r.title}
            </h2>
            <p className="text-sm text-stone-600 leading-relaxed">{r.body}</p>
          </section>
        ))}
      </div>
      <p className="text-sm text-stone-500 mt-6">
        相关文档：
        <Link href="/privacy" className="text-amber-700 hover:underline mx-1">隐私政策</Link>·
        <Link href="/terms" className="text-amber-700 hover:underline mx-1">用户协议</Link>
      </p>
    </div>
  );
}

