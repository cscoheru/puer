"use client";

import CreateSessionForm from "@/components/sessions/create-session-form";

export default function NewSessionPage() {
  return (
    <div className="max-w-2xl mx-auto px-3 md:px-4 py-6">
      <h1 className="text-2xl font-bold text-stone-800 mb-6">发起茶会</h1>
      <CreateSessionForm />
    </div>
  );
}
