import { trackRequest } from '@/lib/usage-meter'
import { NextResponse } from "next/server";

async function GET$() {
  return NextResponse.json({ message: "Hello, world!" });
}

// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──
export const GET = trackRequest(
  'api/route.ts',
  GET$,
)
