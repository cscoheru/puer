"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { BREW_METHODS, INVITE_MINIMUM } from "@/lib/session-constants";
import ImageUploadGrid from "./image-upload-grid";
import InviteFriends from "./invite-friends";

type Step = 1 | 2 | 3 | 4;

const DURATION_OPTIONS = [
  { value: 30, label: "30分钟" },
  { value: 60, label: "1小时" },
  { value: 90, label: "1.5小时" },
  { value: 120, label: "2小时" },
];

export default function CreateSessionForm() {
  const { data: session } = useSession();
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    title: "",
    teaName: "",
    description: "",
    brewMethod: "gongfu",
    waterTemp: "",
    teaWeight: "",
    images: [] as string[],
    scheduledAt: "",
    duration: 60,
    invitedUserIds: [] as string[],
  });

  if (!session?.user) {
    return (
      <div className="text-center py-16 text-stone-400">
        <p>请先登录</p>
      </div>
    );
  }

  if ((session.user.level ?? 0) < 2) {
    return (
      <div className="text-center py-16 text-stone-400">
        <div className="text-5xl mb-4">🍵</div>
        <p>Lv.2 以上才能发起茶会</p>
      </div>
    );
  }

  const update = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const canNext = (): boolean => {
    switch (step) {
      case 1:
        return form.title.trim().length > 0 && form.teaName.trim().length > 0;
      case 2:
        return form.scheduledAt.length > 0 && form.duration >= 15;
      case 3:
        return form.invitedUserIds.length >= INVITE_MINIMUM;
      default:
        return true;
    }
  };

  const nextStep = () => {
    if (step < 4 && canNext()) setStep((step + 1) as Step);
  };

  const prevStep = () => {
    if (step > 1) setStep((step - 1) as Step);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          teaName: form.teaName,
          description: form.description || null,
          coverImage: form.images[0] || null,
          images: form.images,
          brewMethod: form.brewMethod,
          waterTemp: form.waterTemp ? parseInt(form.waterTemp, 10) : null,
          teaWeight: form.teaWeight || null,
          scheduledAt: form.scheduledAt,
          duration: form.duration,
          invitedUserIds: form.invitedUserIds,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }

      const data = await res.json();
      router.push(`/sessions/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setLoading(false);
    }
  };

  const STEPS = [
    { key: 1, label: "茶会信息" },
    { key: 2, label: "时间设置" },
    { key: 3, label: "邀请茶友" },
    { key: 4, label: "确认发布" },
  ];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-0 mb-8">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium transition-colors ${
                step === s.key
                  ? "bg-amber-600 text-white"
                  : step > s.key
                  ? "bg-amber-100 text-amber-700"
                  : "bg-stone-100 text-stone-400"
              }`}
            >
              {step > s.key ? "✓" : s.key}
            </div>
            <span
              className={`ml-2 text-sm hidden sm:inline ${
                step === s.key ? "text-amber-700 font-medium" : "text-stone-400"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div className="w-8 sm:w-12 h-px mx-2 bg-stone-200" />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-5 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>
      )}

      {/* Step 1: Tea info */}
      {step === 1 && (
        <div className="space-y-5">
          <h2 className="text-lg font-bold text-stone-800">茶会信息</h2>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶会标题 *</label>
            <input
              required
              value={form.title}
              onChange={update("title")}
              placeholder="如：周末一起喝泡2005易昌号"
              className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶品名称 *</label>
            <input
              required
              value={form.teaName}
              onChange={update("teaName")}
              placeholder="如：2005易昌号珍品"
              className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶会图片</label>
            <ImageUploadGrid
              value={form.images}
              onChange={(urls) => setForm((prev) => ({ ...prev, images: urls }))}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">简介</label>
            <textarea
              value={form.description}
              onChange={update("description")}
              rows={3}
              placeholder="聊聊这泡茶的来历和期待..."
              className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">泡法</label>
              <select
                value={form.brewMethod}
                onChange={update("brewMethod")}
                className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
              >
                {BREW_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">水温 (℃)</label>
              <input
                type="number"
                value={form.waterTemp}
                onChange={update("waterTemp")}
                placeholder="95"
                className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">投茶量</label>
              <input
                value={form.teaWeight}
                onChange={update("teaWeight")}
                placeholder="如: 8g"
                className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Time settings */}
      {step === 2 && (
        <div className="space-y-5">
          <h2 className="text-lg font-bold text-stone-800">时间设置</h2>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">预约时间 *</label>
            <input
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(e) => setForm((prev) => ({ ...prev, scheduledAt: e.target.value }))}
              min={new Date(Date.now() + 3600000).toISOString().slice(0, 16)}
              className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <p className="text-xs text-stone-400 mt-1">茶会将在此时间自动开始，请提前进入茶席</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶会时长 *</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, duration: opt.value }))}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition border ${
                    form.duration === opt.value
                      ? "bg-amber-600 text-white border-amber-600"
                      : "bg-white text-stone-600 border-stone-200 hover:border-amber-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <div className="relative">
                <input
                  type="number"
                  value={form.duration}
                  onChange={(e) => setForm((prev) => ({ ...prev, duration: parseInt(e.target.value) || 60 }))}
                  min={15}
                  max={480}
                  className="w-20 px-3 py-2 border border-amber-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-stone-400 pointer-events-none">分钟</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Invite friends */}
      {step === 3 && (
        <div className="space-y-5">
          <h2 className="text-lg font-bold text-stone-800">邀请茶友</h2>
          <p className="text-sm text-stone-500">邀请至少 {INVITE_MINIMUM} 位茶友，被邀请人接受后茶会才能开始</p>
          <InviteFriends
            selected={form.invitedUserIds}
            onChange={(ids) => setForm((prev) => ({ ...prev, invitedUserIds: ids }))}
            min={INVITE_MINIMUM}
          />
        </div>
      )}

      {/* Step 4: Review */}
      {step === 4 && (
        <div className="space-y-5">
          <h2 className="text-lg font-bold text-stone-800">确认发布</h2>

          <div className="bg-stone-50 rounded-xl p-4 space-y-3">
            {/* Images */}
            {form.images.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {form.images.map((url, i) => (
                  <div key={url} className="relative flex-shrink-0">
                    <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover" />
                    {i === 0 && <span className="absolute top-0 left-0 text-[0.625rem] bg-amber-600 text-white px-1 rounded-br-lg">封面</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-stone-400">标题</span>
                <p className="font-medium text-stone-700">{form.title}</p>
              </div>
              <div>
                <span className="text-stone-400">茶品</span>
                <p className="font-medium text-stone-700">{form.teaName}</p>
              </div>
              {form.description && (
                <div className="col-span-2">
                  <span className="text-stone-400">简介</span>
                  <p className="text-stone-600">{form.description}</p>
                </div>
              )}
              <div>
                <span className="text-stone-400">泡法</span>
                <p className="text-stone-600">{BREW_METHODS.find((m) => m.value === form.brewMethod)?.label}</p>
              </div>
              <div>
                <span className="text-stone-400">预约时间</span>
                <p className="text-stone-600">{new Date(form.scheduledAt).toLocaleString("zh-CN")}</p>
              </div>
              <div>
                <span className="text-stone-400">时长</span>
                <p className="text-stone-600">{form.duration} 分钟</p>
              </div>
              <div>
                <span className="text-stone-400">邀请茶友</span>
                <p className="text-stone-600">{form.invitedUserIds.length} 人</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex justify-between mt-8 pt-5 border-t border-amber-100">
        <div>
          {step > 1 && (
            <button
              type="button"
              onClick={prevStep}
              className="px-4 py-2 text-stone-500 hover:text-stone-700 transition text-sm"
            >
              上一步
            </button>
          )}
        </div>
        <div>
          {step < 4 ? (
            <button
              type="button"
              onClick={nextStep}
              disabled={!canNext()}
              className="px-6 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm font-medium disabled:opacity-50"
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="px-6 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm font-medium disabled:opacity-50"
            >
              {loading ? "创建中..." : "发起茶会"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
