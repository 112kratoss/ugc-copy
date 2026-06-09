import { NextResponse } from 'next/server';

import { listSourceToolsCatalog } from '@/lib/source-tools-server';

export async function GET() {
  const tools = await listSourceToolsCatalog();
  return NextResponse.json({ tools });
}
