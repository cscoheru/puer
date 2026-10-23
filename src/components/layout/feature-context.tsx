"use client";

import { createContext, useContext } from "react";

/**
 * 把服务端的 feature flag 状态送到客户端（PRD v0.3 §5「所有新功能走
 * feature flag」）。
 *
 * ## 为什么需要这一层
 *
 * flag 的判定读 `process.env`，那是**服务端**的事。客户端组件读不到
 * 非 `NEXT_PUBLIC_` 的环境变量 —— Next.js 在构建时就把客户端包里的
 * `process.env.X` 内联掉，非公开变量会被替换成 undefined。
 *
 * 所以值由服务端布局算好，往下传。传的是**快照**（一个布尔表），
 * 不是函数 —— 客户端拿不到环境变量，就不该有机会重新判定。
 *
 * ## 用法
 *
 *   服务端：<Providers features={featureFlagSnapshot()}>
 *   客户端：const cellarOn = useFeatureFlag("cellar");
 *
 * 拿不到值时**默认 false**：flag 关着的功能不该出现在导航里。
 */

export type FeatureState = Record<string, boolean>;

const FeatureContext = createContext<FeatureState>({});

export function FeatureProvider({
  features,
  children,
}: {
  features: FeatureState;
  children: React.ReactNode;
}) {
  return (
    <FeatureContext.Provider value={features}>{children}</FeatureContext.Provider>
  );
}

/** 读一个 flag。默认 false（拿不到 = 没开）。 */
export function useFeatureFlag(name: string): boolean {
  return useContext(FeatureContext)[name] ?? false;
}
