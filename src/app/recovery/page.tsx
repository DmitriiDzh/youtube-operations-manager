"use client";

import Link from "next/link";
import { OperationLockControl } from "@/components/operation-lock-control";

// Stuck-lock recovery page. Deliberately has no session/database dependency of its own: it is what
// the operator opens when the app could not finish starting because an export/import/schema
// migration lock was left behind (see docs/ARCHITECTURE.md, "Stuck operation lock recovery"). It
// only talks to /api/operation-lock, which is independent of the database initialization.
export default function RecoveryPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Startup recovery</h1>
        <p className="mt-2 text-sm text-zinc-400">
          If the app reported that an operation is already in progress and will not start, the lock below is the
          reason. This page refreshes on its own.
        </p>
      </div>
      <OperationLockControl />
      <Link href="/dashboard" className="text-sm text-blue-400 hover:underline">
        Open the dashboard
      </Link>
    </div>
  );
}
