"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  teaTypeLabel,
  specLabel,
  requestStatusLabel,
  TRADE_METHODS,
  TEA_TYPES,
  WEIGHT_SPECS,
} from "./constants";
import AuthorHover from "@/components/author-hover";
import { uploadWithRetry } from "@/lib/upload-client";

interface ReplyItem {
  id: string;
  replyBy: string; // requester | responder
  replyType: string; // message | counter_offer
  offerSwapBrand: string | null;
  offerSwapWeight: number | null;
  offerPrice: number | null;
  message: string | null;
  createdAt: string;
}

interface TradeRequestItem {
  id: string;
  requestType: string; // swap | purchase
  status: string;
  tradeMethod: string | null;
  round: number;
  lastReplyBy: string | null;
  requesterConfirmedDisclaimer: boolean;
  responderConfirmedDisclaimer: boolean;
  offerSwapBrand: string | null;
  offerSwapWeight: number | null;
  offerPrice: number | null;
  message: string | null;
  createdAt: string;
  requester: {
    id: string;
    username: string;
    avatar: string | null;
    level: number;
    karma: number;
    followerCount: number;
    bio: string | null;
    teaAge: number | null;
    createdAt: string;
  };
  responder: {
    id: string;
    username: string;
    avatar: string | null;
    level: number;
    karma: number;
    followerCount: number;
    bio: string | null;
    teaAge: number | null;
    createdAt: string;
  };
  inventoryItem: {
    id: string;
    brand: string;
    type: string;
    year: number;
    spec: string;
    remainingWeight: number;
    images: string[];
  } | null;
  replies: ReplyItem[];
}

interface Props {
  userId: string;
}

export default function TradeRequestList({ userId }: Props) {
  const { data: session } = useSession();
  const [role, setRole] = useState<"incoming" | "outgoing">("incoming");
  const [requests, setRequests] = useState<TradeRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedReply, setExpandedReply] = useState<string | null>(null);
  const [expandedCounter, setExpandedCounter] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [disclaimerChecked, setDisclaimerChecked] = useState<Record<string, boolean>>({});

  // Counter-offer form state per request
  const [counterOffer, setCounterOffer] = useState<
    Record<
      string,
      {
        price: string;
        swapBrand: string;
        swapType: string;
        swapYear: string;
        swapSpec: string;
        swapWeight: string;
        message: string;
      }
    >
  >({});

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/trade-request?role=${role}`);
      const data = await res.json();
      setRequests(data.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [role]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function handleAction(id: string, action: "accept" | "reject") {
    const res = await fetch(`/api/trade-request/${id}/${action}`, {
      method: "POST",
    });
    if (res.ok) fetchRequests();
  }

  async function handleConfirm(id: string, tradeMethod: string) {
    const res = await fetch(`/api/trade-request/${id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeMethod }),
    });
    if (res.ok) fetchRequests();
  }

  async function handleDisclaimerConfirm(id: string) {
    const res = await fetch(`/api/trade-request/${id}/confirm-disclaimer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (res.ok) fetchRequests();
  }

  async function handleReply(id: string) {
    const msg = (replyText[id] || "").trim();
    if (!msg) return;
    setSubmitting((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/trade-request/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyType: "message", message: msg }),
      });
      if (res.ok) {
        setReplyText((s) => ({ ...s, [id]: "" }));
        setExpandedReply(null);
        fetchRequests();
      }
    } catch {
      // ignore
    } finally {
      setSubmitting((s) => ({ ...s, [id]: false }));
    }
  }

  async function handleCounterOffer(id: string, requestType: string) {
    const co = counterOffer[id];
    if (!co) return;
    setSubmitting((s) => ({ ...s, [id]: true }));
    try {
      const body: Record<string, unknown> = {
        replyType: "counter_offer",
        message: co.message || null,
      };
      if (requestType === "purchase") {
        body.offerPrice = co.price ? Number(co.price) : null;
      } else {
        body.offerSwapBrand = co.swapBrand || null;
        body.offerSwapWeight = co.swapWeight ? Number(co.swapWeight) : null;
      }
      const res = await fetch(`/api/trade-request/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setCounterOffer((s) => {
          const next = { ...s };
          delete next[id];
          return next;
        });
        setExpandedCounter(null);
        fetchRequests();
      }
    } catch {
      // ignore
    } finally {
      setSubmitting((s) => ({ ...s, [id]: false }));
    }
  }

  function initCounterOffer(id: string, requestType: string) {
    setCounterOffer((s) => ({
      ...s,
      [id]: {
        price: "",
        swapBrand: "",
        swapType: "raw",
        swapYear: new Date().getFullYear().toString(),
        swapSpec: "357g",
        swapWeight: "",
        message: "",
      },
    }));
    setExpandedCounter(id);
    setExpandedReply(null);
  }

  function isParty(req: TradeRequestItem): boolean {
    if (!session?.user?.id) return false;
    return (
      session.user.id === req.requester.id ||
      session.user.id === req.responder.id
    );
  }

  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-stone-400">加载中...</div>
    );
  }

  return (
    <div>
      {/* Role tabs */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setRole("incoming")}
          className={`px-3 py-1.5 text-sm rounded transition ${
            role === "incoming"
              ? "bg-amber-600 text-white"
              : "bg-stone-100 text-stone-600 hover:bg-stone-200"
          }`}
        >
          收到的请求
        </button>
        <button
          onClick={() => setRole("outgoing")}
          className={`px-3 py-1.5 text-sm rounded transition ${
            role === "outgoing"
              ? "bg-amber-600 text-white"
              : "bg-stone-100 text-stone-600 hover:bg-stone-200"
          }`}
        >
          发出的请求
        </button>
      </div>

      {requests.length === 0 ? (
        <div className="text-center py-8 text-sm text-stone-400 bg-white rounded-xl border border-dashed border-stone-200">
          暂无{role === "incoming" ? "收到的" : "发出的"}请求
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => {
            const other =
              role === "incoming" ? req.requester : req.responder;
            const isPending = req.status === "pending";
            const isAccepted = req.status === "accepted";
            const isConfirmed = req.status === "confirmed";
            const isSuperseded = req.status === "superseded";
            const userIsRequester =
              session?.user?.id === req.requester.id;
            const otherConfirmedDisclaimer = userIsRequester
              ? req.responderConfirmedDisclaimer
              : req.requesterConfirmedDisclaimer;
            const canReply =
              isPending &&
              req.round < 3 &&
              isParty(req);
            const showRound = isPending || isAccepted;

            return (
              <div
                key={req.id}
                className={`bg-white border rounded-lg p-4 space-y-2 ${
                  isSuperseded
                    ? "border-stone-200 opacity-60"
                    : "border-stone-200"
                }`}
              >
                {/* Header: other user + status + round */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <AuthorHover
                      author={{
                        id: other.id,
                        username: other.username,
                        avatar: other.avatar,
                        level: other.level,
                        bio: other.bio,
                        teaAge: other.teaAge,
                        createdAt: other.createdAt,
                        karma: other.karma,
                        followerCount: other.followerCount,
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {showRound && (
                      <span className="text-xs text-stone-400">
                        第 {req.round + 1}/3 轮
                      </span>
                    )}
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        isSuperseded
                          ? "bg-stone-100 text-stone-400"
                          : req.status === "pending"
                          ? "bg-yellow-50 text-yellow-700"
                          : req.status === "accepted"
                          ? "bg-green-50 text-green-700"
                          : req.status === "confirmed"
                          ? "bg-blue-50 text-blue-700"
                          : req.status === "rejected"
                          ? "bg-red-50 text-red-700"
                          : req.status === "cancelled"
                          ? "bg-stone-100 text-stone-500"
                          : "bg-stone-50 text-stone-500"
                      }`}
                    >
                      {requestStatusLabel(req.status)}
                    </span>
                  </div>
                </div>

                {/* Superseded notice */}
                {isSuperseded && (
                  <div className="text-xs text-stone-400 bg-stone-50 rounded px-2 py-1.5">
                    该茶版已与其他交易者成交
                  </div>
                )}

                {/* Target item */}
                {req.inventoryItem && !isSuperseded && (
                  <div className="flex gap-2 bg-stone-50 rounded p-2">
                    {req.inventoryItem.images?.[0] && (
                      <img
                        src={req.inventoryItem.images[0]}
                        alt=""
                        className="w-10 h-10 rounded object-cover"
                      />
                    )}
                    <div className="text-xs text-stone-600">
                      {req.inventoryItem.brand} {req.inventoryItem.year}{" "}
                      {teaTypeLabel(req.inventoryItem.type)}{" "}
                      {specLabel(req.inventoryItem.spec)}
                    </div>
                  </div>
                )}

                {/* Current offer details */}
                {!isSuperseded && (
                  <div className="text-xs text-stone-500">
                    {req.requestType === "swap" ? (
                      <>
                        置换：{req.offerSwapBrand || "-"}
                        {req.offerSwapWeight ? ` ${req.offerSwapWeight}g` : ""}
                      </>
                    ) : (
                      <>
                        购买：
                        {req.offerPrice
                          ? `¥${Number(req.offerPrice).toLocaleString()}`
                          : "¥-"}
                      </>
                    )}
                    {req.message && (
                      <p className="mt-1 text-stone-400">"{req.message}"</p>
                    )}
                  </div>
                )}

                {/* Reply / counter-offer history timeline */}
                {req.replies && req.replies.length > 0 && !isSuperseded && (
                  <div className="mt-2 border-l-2 border-amber-200 pl-3 space-y-2">
                    {req.replies.map((reply, idx) => {
                      const isRequester = reply.replyBy === "requester";
                      const isCounter =
                        reply.replyType === "counter_offer";
                      const replyAuthor = isRequester
                        ? req.requester
                        : req.responder;
                      return (
                        <div
                          key={reply.id}
                          className={`text-xs rounded px-2 py-1.5 ${
                            idx % 2 === 0
                              ? "bg-stone-50"
                              : "bg-amber-50/40"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="font-medium text-stone-700">
                              {replyAuthor.username}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] ${
                                isCounter
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-stone-100 text-stone-500"
                              }`}
                            >
                              {isCounter ? "还价" : "消息"}
                            </span>
                            <span className="text-stone-400 ml-auto">
                              {new Date(reply.createdAt).toLocaleString(
                                "zh-CN",
                                {
                                  month: "numeric",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }
                              )}
                            </span>
                          </div>
                          {isCounter && (
                            <div className="text-stone-600 mb-0.5">
                              {req.requestType === "purchase"
                                ? `出价：¥${reply.offerPrice ? Number(reply.offerPrice).toLocaleString() : "-"}`
                                : `置换：${reply.offerSwapBrand || "-"}${reply.offerSwapWeight ? ` ${reply.offerSwapWeight}g` : ""}`}
                            </div>
                          )}
                          {reply.message && (
                            <div className="text-stone-400">
                              {reply.message}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Actions: accept / reject for incoming pending */}
                {role === "incoming" && isPending && !isSuperseded && (
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => handleAction(req.id, "accept")}
                      className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 transition"
                    >
                      接受
                    </button>
                    <button
                      onClick={() => handleAction(req.id, "reject")}
                      className="px-3 py-1.5 border border-stone-300 text-stone-600 text-xs rounded hover:bg-stone-50 transition"
                    >
                      拒绝
                    </button>
                  </div>
                )}

                {/* Reply / counter-offer buttons for active parties */}
                {canReply && !isSuperseded && (
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => {
                        setExpandedReply(
                          expandedReply === req.id ? null : req.id
                        );
                        setExpandedCounter(null);
                      }}
                      className={`px-3 py-1.5 text-xs rounded transition ${
                        expandedReply === req.id
                          ? "bg-amber-600 text-white"
                          : "border border-amber-300 text-amber-700 hover:bg-amber-50"
                      }`}
                    >
                      回复
                    </button>
                    <button
                      onClick={() =>
                        initCounterOffer(req.id, req.requestType)
                      }
                      className={`px-3 py-1.5 text-xs rounded transition ${
                        expandedCounter === req.id
                          ? "bg-amber-600 text-white"
                          : "border border-amber-300 text-amber-700 hover:bg-amber-50"
                      }`}
                    >
                      还价
                    </button>
                  </div>
                )}

                {/* Inline reply form */}
                {expandedReply === req.id && (
                  <div className="space-y-2 pt-1">
                    <textarea
                      value={replyText[req.id] || ""}
                      onChange={(e) =>
                        setReplyText((s) => ({
                          ...s,
                          [req.id]: e.target.value,
                        }))
                      }
                      placeholder="输入回复内容..."
                      className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-amber-400"
                      rows={3}
                    />
                    <button
                      onClick={() => handleReply(req.id)}
                      disabled={
                        submitting[req.id] ||
                        !(replyText[req.id] || "").trim()
                      }
                      className="px-4 py-1.5 bg-amber-600 text-white text-xs rounded hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {submitting[req.id] ? "发送中..." : "发送回复"}
                    </button>
                  </div>
                )}

                {/* Inline counter-offer form */}
                {expandedCounter === req.id && counterOffer[req.id] && (
                  <div className="space-y-2 pt-1 border-t border-stone-100">
                    {req.requestType === "purchase" ? (
                      <div>
                        <label className="text-xs text-stone-500 block mb-1">
                          出价 (元)
                        </label>
                        <input
                          type="number"
                          value={counterOffer[req.id].price}
                          onChange={(e) =>
                            setCounterOffer((s) => ({
                              ...s,
                              [req.id]: {
                                ...s[req.id],
                                price: e.target.value,
                              },
                            }))
                          }
                          placeholder="输入价格"
                          className="w-full border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">
                            品牌
                          </label>
                          <input
                            type="text"
                            value={counterOffer[req.id].swapBrand}
                            onChange={(e) =>
                              setCounterOffer((s) => ({
                                ...s,
                                [req.id]: {
                                  ...s[req.id],
                                  swapBrand: e.target.value,
                                },
                              }))
                            }
                            placeholder="茶品牌"
                            className="w-full border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">
                            类型
                          </label>
                          <select
                            value={counterOffer[req.id].swapType}
                            onChange={(e) =>
                              setCounterOffer((s) => ({
                                ...s,
                                [req.id]: {
                                  ...s[req.id],
                                  swapType: e.target.value,
                                },
                              }))
                            }
                            className="w-full border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                          >
                            {TEA_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">
                            年份
                          </label>
                          <input
                            type="number"
                            value={counterOffer[req.id].swapYear}
                            onChange={(e) =>
                              setCounterOffer((s) => ({
                                ...s,
                                [req.id]: {
                                  ...s[req.id],
                                  swapYear: e.target.value,
                                },
                              }))
                            }
                            placeholder="年份"
                            className="w-full border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-stone-500 block mb-1">
                            规格
                          </label>
                          <select
                            value={counterOffer[req.id].swapSpec}
                            onChange={(e) =>
                              setCounterOffer((s) => ({
                                ...s,
                                [req.id]: {
                                  ...s[req.id],
                                  swapSpec: e.target.value,
                                },
                              }))
                            }
                            className="w-full border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                          >
                            {WEIGHT_SPECS.map((w) => (
                              <option key={w.value} value={w.value}>
                                {w.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="text-xs text-stone-500 block mb-1">
                            重量 (克)
                          </label>
                          <input
                            type="number"
                            value={counterOffer[req.id].swapWeight}
                            onChange={(e) =>
                              setCounterOffer((s) => ({
                                ...s,
                                [req.id]: {
                                  ...s[req.id],
                                  swapWeight: e.target.value,
                                },
                              }))
                            }
                            placeholder="克数"
                            className="w-full border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="text-xs text-stone-500 block mb-1">
                        留言
                      </label>
                      <textarea
                        value={counterOffer[req.id].message}
                        onChange={(e) =>
                          setCounterOffer((s) => ({
                            ...s,
                            [req.id]: {
                              ...s[req.id],
                              message: e.target.value,
                            },
                          }))
                        }
                        placeholder="附言说明..."
                        className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-amber-400"
                        rows={2}
                      />
                    </div>
                    <button
                      onClick={() =>
                        handleCounterOffer(req.id, req.requestType)
                      }
                      disabled={submitting[req.id]}
                      className="px-4 py-1.5 bg-amber-600 text-white text-xs rounded hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {submitting[req.id] ? "提交中..." : "提交还价"}
                    </button>
                  </div>
                )}

                {/* Trade method confirmation (after accept) */}
                {isAccepted && !isSuperseded && !req.tradeMethod && (
                  <div className="space-y-2 pt-1 border-t border-stone-100">
                    <p className="text-xs text-stone-500">选择交易方式：</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          handleConfirm(req.id, "self_delivery")
                        }
                        className="px-3 py-1.5 bg-amber-600 text-white text-xs rounded hover:bg-amber-700 transition"
                      >
                        自行交易
                      </button>
                      <button
                        disabled
                        title="开发中"
                        className="px-3 py-1.5 bg-stone-200 text-stone-400 text-xs rounded cursor-not-allowed relative group"
                      >
                        平台验货（开发中）
                        <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-stone-700 text-white text-[10px] px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
                          开发中
                        </span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Disclaimer confirmation after trade method selected */}
                {isAccepted &&
                  !isSuperseded &&
                  req.tradeMethod === "self_delivery" && (
                    <div className="space-y-2 pt-1 border-t border-stone-100">
                      <p className="text-xs text-stone-500">
                        交易方式：自行交易
                      </p>
                      {otherConfirmedDisclaimer && (
                        <p className="text-xs text-green-600">
                          对方已确认免责声明
                        </p>
                      )}
                      {!otherConfirmedDisclaimer && (
                        <p className="text-xs text-stone-400">
                          等待对方确认免责声明...
                        </p>
                      )}
                      <label className="flex items-start gap-2 text-xs text-stone-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={disclaimerChecked[req.id] || false}
                          onChange={(e) =>
                            setDisclaimerChecked((s) => ({
                              ...s,
                              [req.id]: e.target.checked,
                            }))
                          }
                          className="mt-0.5 rounded border-stone-300 text-amber-600 focus:ring-amber-400"
                        />
                        <span className="leading-relaxed">
                          我已阅读并同意：交易有风险，请确认钱款和茶版符合要求，关于本交易产生的纠纷与本平台无关
                        </span>
                      </label>
                      <button
                        onClick={() => handleDisclaimerConfirm(req.id)}
                        disabled={!disclaimerChecked[req.id]}
                        className="px-4 py-1.5 bg-amber-600 text-white text-xs rounded hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        确认免责声明
                      </button>
                    </div>
                  )}

                {/* Confirmed state */}
                {isConfirmed && !isSuperseded && (
                  <div className="text-xs text-blue-600 bg-blue-50 rounded px-2 py-1.5">
                    交易已确认，{req.tradeMethod === "self_delivery" ? "请自行联系对方完成交易" : ""}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
